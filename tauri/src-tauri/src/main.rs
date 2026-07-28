#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde::Serialize;
use serde_json::{json, Value};
use std::{
    collections::HashSet,
    env, fs,
    io::{BufRead, BufReader, Read as IoRead, Write},
    net::{TcpStream, ToSocketAddrs},
    path::{Path, PathBuf},
    process::{Child, ChildStdin, Command, Stdio},
    sync::{
        atomic::{AtomicU64, Ordering},
        mpsc, Arc, Mutex,
    },
    thread,
    time::{Duration, Instant, UNIX_EPOCH},
};
use tauri::{Emitter, Manager, State};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[cfg(windows)]
use windows_sys::Win32::Graphics::Dwm::{
    DwmSetWindowAttribute, DWMWA_BORDER_COLOR, DWMWA_CAPTION_COLOR, DWMWA_COLOR_NONE,
};

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x08000000;

struct DaemonState {
    child: Arc<Mutex<Option<Child>>>,
    stdin: Arc<Mutex<Option<ChildStdin>>>,
    /// The Garrison gateway (`garrison serve`) that hosts the Telegram bridge.
    /// Owned by the app so it dies WITH the app — the fix for the bridge that
    /// kept answering after the EXE "closed" (it was a manual, unowned process).
    garrison: Arc<Mutex<Option<Child>>>,
    root: Mutex<Option<PathBuf>>,
    provider: Mutex<Option<String>>,
    model: Mutex<Option<String>>,
    events: Arc<Mutex<Vec<BufferedEvent>>>,
    next_event_seq: Arc<AtomicU64>,
    /// Bumped on every (re)start so stale exit-watchers from a previous child
    /// can tell they are watching a dead generation and stand down.
    generation: Arc<AtomicU64>,
}

/// The local Kokoro voice sidecar (voice_service/server.py) — auto-started with
/// the app so spoken replies "just work", and killed on close. First run
/// self-provisions the Python venv + deps so "Hey Ares" needs zero manual setup.
struct VoiceState {
    child: Arc<Mutex<Option<Child>>>,
    /// (phase, detail) — "idle" | "setup" | "starting" | "running" | "error" | "missing".
    phase: Arc<Mutex<(String, String)>>,
    setup_running: Arc<Mutex<bool>>,
    /// Bumped on every stop/restart so stale exit-watchers stand down.
    generation: Arc<AtomicU64>,
    /// Consecutive unexpected exits. The supervisor restarts a transient crash
    /// automatically, but stops after a small bounded burst instead of looping.
    crash_count: Arc<AtomicU64>,
    /// Per-launch shared secret the sidecar requires on every WS/HTTP request.
    /// Without it, any web page could reach ws://127.0.0.1:8765 and drive the
    /// mic/TTS; the webview learns the token via ares_voice_status.
    token: String,
    /// Per-launch loopback port. A fixed 8765 collided with plugin sidecars
    /// (notably image generation), making Repair deterministically fail.
    port: u16,
}

/// Presentation-only state for the click-through, monitor-sized voice overlay.
/// Keeping the latest snapshot in Rust means a newly-created overlay cannot
/// miss the first event while its WebView is still booting.
struct PresenceState {
    snapshot: Mutex<PresenceSnapshot>,
}

/// Session handoff for the experimental renderer. Passing this through a hash
/// made WebView2 intermittently leave dynamically-created windows at
/// `about:blank`; the renderer now reads it over the trusted Tauri bridge after
/// loading a plain, deterministic asset URL.
struct LivingSurfaceState {
    session_id: Mutex<Option<String>>,
    /// The staged generated document, served over the ares-surface:// scheme.
    /// A srcdoc iframe INHERITS the app CSP (whose build-time style hashes and
    /// script-src 'self' silently strip every generated <style>/<script> in
    /// packaged builds); a scheme-served document owns its headers instead.
    document: Mutex<Option<String>>,
    doc_seq: AtomicU64,
}

/// The generated surface's entire authority. Inline script/style may run, but
/// every network request — fetch, XHR, imports, css url(), beacons — is refused.
const LIVING_SURFACE_CSP: &str = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; media-src data: blob:; font-src data:;";

#[derive(Clone, Serialize)]
struct PresenceSnapshot {
    visible: bool,
    mode: String,
    caption: String,
    detail: String,
}

impl Default for PresenceSnapshot {
    fn default() -> Self {
        Self {
            visible: false,
            mode: "idle".into(),
            caption: String::new(),
            detail: String::new(),
        }
    }
}

/// A random 128-bit hex token. RandomState is seeded from the OS CSPRNG on each
/// construction, so hashing distinct values yields unpredictable output — enough
/// to gate a loopback service against a blind same-machine web attacker.
fn random_token() -> String {
    use std::hash::{BuildHasher, Hash, Hasher};
    let mk = || {
        let state = std::collections::hash_map::RandomState::new();
        let mut h = state.build_hasher();
        std::time::SystemTime::now().hash(&mut h);
        std::process::id().hash(&mut h);
        std::thread::current().id().hash(&mut h);
        h.finish()
    };
    format!("{:016x}{:016x}", mk(), mk())
}

fn available_loopback_port() -> u16 {
    std::net::TcpListener::bind(("127.0.0.1", 0))
        .and_then(|listener| listener.local_addr())
        .map(|addr| addr.port())
        .unwrap_or(8765)
}

struct AresRuntime {
    app_root: PathBuf,
    cli_entry: PathBuf,
    node: PathBuf,
    workspace: PathBuf,
}

#[derive(Serialize)]
struct DaemonStatus {
    running: bool,
    root: Option<String>,
    provider: Option<String>,
    model: Option<String>,
}

#[derive(Serialize)]
struct AgentIdentity {
    name: Option<String>,
    avatar: Option<String>,
    mark: Option<String>,
}

#[derive(Clone, Serialize)]
struct BufferedEvent {
    seq: u64,
    event: Value,
}

#[derive(Serialize)]
struct OllamaModel {
    id: String,
    hint: String,
    group: String,
    source: String,
    size: Option<u64>,
    #[serde(rename = "modifiedAt")]
    modified_at: Option<String>,
    description: Option<String>,
    family: Option<String>,
    parameters: Option<String>,
    quantization: Option<String>,
    #[serde(rename = "contextWindow")]
    context_window: Option<u64>,
    modalities: Vec<String>,
    capabilities: Vec<String>,
    #[serde(rename = "storagePath")]
    storage_path: Option<String>,
}

#[derive(Serialize)]
struct OllamaDiscovery {
    host: String,
    reachable: bool,
    models: Vec<OllamaModel>,
    error: Option<String>,
    #[serde(rename = "localRoot")]
    local_root: Option<String>,
}

#[tauri::command]
fn ares_set_theme(name: String) -> String {
    name
}

#[tauri::command]
fn ares_dev_mode() -> bool {
    env::var("ARES_DEV")
        .map(|value| value == "1" || value.eq_ignore_ascii_case("true"))
        .unwrap_or(false)
        || cfg!(debug_assertions)
}

#[tauri::command]
fn ares_ollama_models() -> OllamaDiscovery {
    discover_ollama_models()
}

#[tauri::command]
fn ares_agent_identity() -> AgentIdentity {
    load_agent_identity()
}

#[tauri::command]
fn ares_self_model() -> Option<Value> {
    load_self_model()
}

#[tauri::command]
fn ares_daemon_status(state: State<DaemonState>) -> DaemonStatus {
    daemon_status(state.inner())
}

#[tauri::command]
fn ares_drain_events(state: State<DaemonState>, after: Option<u64>) -> Vec<BufferedEvent> {
    let after = after.unwrap_or(0);
    state
        .events
        .lock()
        .map(|events| {
            events
                .iter()
                .filter(|event| event.seq > after)
                .cloned()
                .collect()
        })
        .unwrap_or_default()
}

#[tauri::command]
fn ares_start_daemon(
    app: tauri::AppHandle,
    state: State<DaemonState>,
    provider: Option<String>,
    model: Option<String>,
) -> Result<DaemonStatus, String> {
    start_daemon(app, state.inner(), provider, model)
}

#[tauri::command]
fn ares_restart_daemon(
    app: tauri::AppHandle,
    state: State<DaemonState>,
    provider: Option<String>,
    model: Option<String>,
) -> Result<DaemonStatus, String> {
    stop_existing_daemon(state.inner())?;
    push_event(
        &app,
        state.inner(),
        json!({ "type": "desktop_daemon_restarting" }),
    );
    start_daemon(app, state.inner(), provider, model)
}

fn start_daemon(
    app: tauri::AppHandle,
    state: &DaemonState,
    provider: Option<String>,
    model: Option<String>,
) -> Result<DaemonStatus, String> {
    // Acquire the child lock BEFORE doing any spawn work and hold it across the
    // whole spawn-and-store sequence below. Two concurrent ares_start_daemon
    // invokes used to both observe child==None (the check lived in the caller,
    // released before start_daemon() ran), both fully spawn a daemon+garrison
    // pair, and let the loser's Child handle drop — Child::drop() does not kill
    // the process, so the loser became a permanently orphaned, untracked pair
    // that stop_existing_daemon/kill_child_tree could never reach again. Holding
    // the guard here makes the whole sequence atomic: a second caller sees
    // child_guard.is_some() and returns the already-running status instead of
    // spawning a duplicate.
    let mut child_guard = state.child.lock().map_err(|_| "daemon child lock failed")?;
    if let Some(proc) = child_guard.as_mut() {
        // Live-check rather than trust the handle, mirroring daemon_status() —
        // but we can't call daemon_status() here, it re-locks state.child and
        // this guard is already held (std::sync::Mutex is not reentrant).
        match proc.try_wait() {
            Ok(None) => return Ok(status_from_locked_child(state, true)),
            _ => {
                *child_guard = None; // dead — fall through and start a fresh one
            }
        }
    }

    let runtime = resolve_ares_runtime(Some(&app)).ok_or_else(|| {
        "Could not find Ares runtime. Rebuild the desktop runtime before launching the app."
            .to_string()
    })?;
    fs::create_dir_all(&runtime.workspace)
        .map_err(|error| format!("failed to create Ares workspace: {error}"))?;
    if let Some(home) = desktop_ares_home() {
        fs::create_dir_all(&home)
            .map_err(|error| format!("failed to create Ares home: {error}"))?;
    }

    // New generation: any watcher from a previous child stands down.
    state.generation.fetch_add(1, Ordering::SeqCst);

    let provider = clean_optional(provider);
    let model = clean_optional(model);
    let mut command = Command::new(&runtime.node);
    command
        .arg(&runtime.cli_entry)
        .arg("daemon")
        .arg("--json")
        .arg("--workspace")
        .arg(&runtime.workspace);
    if let Some(provider) = provider.as_ref() {
        command.arg("--provider").arg(provider);
    }
    if let Some(model) = model.as_ref() {
        command.arg("--model").arg(model);
    }
    #[cfg(windows)]
    {
        command.creation_flags(CREATE_NO_WINDOW);
    }

    // If the runtime ships bundled Playwright browser binaries, point Playwright
    // at them so the headless browser launches even on a machine without a system
    // Chrome/Edge. Absent the bundle, Playwright falls back to the system browser
    // (the connector's channel strategy), so leaving this unset is fine.
    let bundled_browsers = runtime.app_root.join("browsers");
    if bundled_browsers.is_dir() {
        command.env("PLAYWRIGHT_BROWSERS_PATH", &bundled_browsers);
    }

    let mut child = command
        .current_dir(&runtime.workspace)
        .env("ARES_AGENT_ENABLED", "1")
        .env("ARES_HOME", desktop_ares_home_string())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| format!("failed to start Ares daemon: {error}"))?;

    let stdin = child
        .stdin
        .take()
        .ok_or_else(|| "daemon stdin unavailable".to_string())?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "daemon stdout unavailable".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "daemon stderr unavailable".to_string())?;

    {
        let mut root_state = state.root.lock().map_err(|_| "daemon root lock failed")?;
        *root_state = Some(runtime.workspace.clone());
    }
    {
        let mut provider_state = state
            .provider
            .lock()
            .map_err(|_| "daemon provider lock failed")?;
        *provider_state = provider.clone();
    }
    {
        let mut model_state = state.model.lock().map_err(|_| "daemon model lock failed")?;
        *model_state = model.clone();
    }
    {
        let mut stdin_state = state.stdin.lock().map_err(|_| "daemon stdin lock failed")?;
        *stdin_state = Some(stdin);
    }
    // Store into the still-held child_guard rather than re-locking — re-locking
    // here would reopen the exact TOCTOU window this fix closes.
    *child_guard = Some(child);

    // Own the Garrison gateway (the Telegram-bridge host) as a tracked child so it
    // dies WITH the app — closing Ares now stops the bridge too. Best-effort: if
    // the gateway can't start (e.g. a stale manual `garrison serve` still holds the
    // port), the desktop session works fine; we just surface the error. Gated on
    // its own lock, held across spawn-and-store, for the same reason as above.
    {
        let mut garrison_guard = state.garrison.lock().map_err(|_| "daemon garrison lock failed")?;
        if garrison_guard.is_none() {
            let mut garrison_cmd = Command::new(&runtime.node);
            garrison_cmd.arg(&runtime.cli_entry).arg("garrison").arg("serve");
            #[cfg(windows)]
            {
                garrison_cmd.creation_flags(CREATE_NO_WINDOW);
            }
            if bundled_browsers.is_dir() {
                garrison_cmd.env("PLAYWRIGHT_BROWSERS_PATH", &bundled_browsers);
            }
            match garrison_cmd
                .current_dir(&runtime.workspace)
                .env("ARES_AGENT_ENABLED", "1")
                .env("ARES_HOME", desktop_ares_home_string())
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()
            {
                Ok(garrison_child) => {
                    *garrison_guard = Some(garrison_child);
                }
                Err(error) => push_event_parts(
                    &app,
                    &state.events,
                    &state.next_event_seq,
                    json!({ "type": "desktop_garrison_error", "error": error.to_string() }),
                ),
            }
        }
    }

    // stdout (the content stream) flows through the coalescer so rapid token
    // deltas become a few IPC pushes instead of hundreds. stderr is low-volume
    // diagnostics — it goes straight to the buffer.
    let coalescer = spawn_event_coalescer(
        app.clone(),
        state.events.clone(),
        state.next_event_seq.clone(),
    );
    let stdout_sink: EventSink = Arc::new(move |value| {
        let _ = coalescer.send(value);
    });
    spawn_output_reader(stdout, false, stdout_sink);

    let stderr_app = app.clone();
    let stderr_events = state.events.clone();
    let stderr_seq = state.next_event_seq.clone();
    let stderr_sink: EventSink = Arc::new(move |value| {
        push_event_parts(&stderr_app, &stderr_events, &stderr_seq, value);
    });
    spawn_output_reader(stderr, true, stderr_sink);
    spawn_exit_watcher(
        app.clone(),
        state.child.clone(),
        state.stdin.clone(),
        state.events.clone(),
        state.next_event_seq.clone(),
        state.generation.clone(),
    );
    push_event(
        &app,
        state,
        json!({
            "type": "desktop_daemon_started",
            "root": runtime.workspace.display().to_string(),
            "provider": provider,
            "model": model
        }),
    );

    Ok(DaemonStatus {
        running: true,
        root: Some(runtime.workspace.display().to_string()),
        provider,
        model,
    })
}

#[tauri::command]
fn ares_send(goal: String, session_id: Option<String>, voice: Option<bool>, state: State<DaemonState>) -> Result<(), String> {
    let trimmed = goal.trim();
    if trimmed.is_empty() {
        return Err("message is empty".to_string());
    }

    write_daemon_command(
        state.inner(),
        json!({ "type": "send", "goal": trimmed, "sessionId": session_id, "voice": voice.unwrap_or(false) }),
    )
}

#[tauri::command]
fn ares_interrupt(session_id: Option<String>, state: State<DaemonState>) -> Result<(), String> {
    // Stop the in-flight turn for this chat. The daemon aborts the provider
    // stream and any running tools; the session stays alive for the next message.
    write_daemon_command(
        state.inner(),
        json!({ "type": "interrupt", "sessionId": session_id }),
    )
}

#[tauri::command]
fn ares_set_reasoning(level: String, state: State<DaemonState>) -> Result<(), String> {
    let level = level.trim().to_ascii_lowercase();
    if !matches!(level.as_str(), "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max") {
        return Err("reasoning level must be off, minimal, low, medium, high, xhigh, or max".to_string());
    }

    write_daemon_command(
        state.inner(),
        json!({ "type": "reasoning", "level": level }),
    )
}

#[tauri::command]
fn ares_set_routing(routing: Value, state: State<DaemonState>) -> Result<(), String> {
    // The owner's per-lane model assignments. Passed through verbatim; the
    // daemon resolves it against @ares/core resolveRoute() on the live turn.
    write_daemon_command(
        state.inner(),
        json!({ "type": "routing", "routing": routing }),
    )
}

/// Forward an arbitrary control command to the daemon (NDJSON over stdin).
/// Used by the desktop for the read-model commands: sessions_list,
/// session_history, engine_config, skills_list, skill_toggle, usage_stats,
/// operator_status. The daemon replies asynchronously on the event stream.
/// Open a URL in the user's default browser (used for the Anthropic OAuth
/// sign-in flow). Validated to http(s) so a daemon event can't open arbitrary
/// programs.
#[tauri::command]
fn ares_open_url(url: String) -> Result<(), String> {
    if !(url.starts_with("https://") || url.starts_with("http://")) {
        return Err("only http(s) URLs may be opened".to_string());
    }
    #[cfg(windows)]
    {
        // ShellExecuteW — the ONLY correct way to open a URL on Windows. Using
        // `cmd /c start` mangles URLs containing `&` (cmd treats it as a command
        // separator), which silently dropped every OAuth query param after the
        // first one. ShellExecuteW takes the whole URL verbatim.
        use windows_sys::Win32::UI::Shell::ShellExecuteW;
        use windows_sys::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;
        let wide: Vec<u16> = url.encode_utf16().chain(std::iter::once(0)).collect();
        let verb: Vec<u16> = "open".encode_utf16().chain(std::iter::once(0)).collect();
        let result = unsafe {
            ShellExecuteW(
                std::ptr::null_mut(),
                verb.as_ptr(),
                wide.as_ptr(),
                std::ptr::null(),
                std::ptr::null(),
                SW_SHOWNORMAL as i32,
            )
        };
        // ShellExecuteW returns a value > 32 on success.
        if (result as isize) <= 32 {
            return Err("failed to open browser".to_string());
        }
        Ok(())
    }
    #[cfg(target_os = "macos")]
    {
        Command::new("open").arg(&url).spawn().map_err(|e| format!("failed to open browser: {e}"))?;
        Ok(())
    }
    #[cfg(all(not(windows), not(target_os = "macos")))]
    {
        Command::new("xdg-open").arg(&url).spawn().map_err(|e| format!("failed to open browser: {e}"))?;
        Ok(())
    }
}

/// Open a forged artifact in the user's default browser. Only existing files
/// are accepted; arguments are passed directly to the OS (never through a shell).
#[tauri::command]
fn ares_open_path(path: String) -> Result<(), String> {
    let target = PathBuf::from(path);
    if !target.is_file() {
        return Err("artifact does not exist".to_string());
    }
    #[cfg(windows)]
    {
        use windows_sys::Win32::UI::Shell::ShellExecuteW;
        use windows_sys::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;
        let wide: Vec<u16> = target.to_string_lossy().encode_utf16().chain(std::iter::once(0)).collect();
        let verb: Vec<u16> = "open".encode_utf16().chain(std::iter::once(0)).collect();
        let result = unsafe { ShellExecuteW(std::ptr::null_mut(), verb.as_ptr(), wide.as_ptr(), std::ptr::null(), std::ptr::null(), SW_SHOWNORMAL as i32) };
        if result as isize <= 32 { return Err("failed to launch artifact".to_string()); }
        Ok(())
    }
    #[cfg(target_os = "macos")]
    { Command::new("open").arg(&target).spawn().map_err(|e| format!("failed to launch artifact: {e}"))?; Ok(()) }
    #[cfg(all(not(windows), not(target_os = "macos")))]
    { Command::new("xdg-open").arg(&target).spawn().map_err(|e| format!("failed to launch artifact: {e}"))?; Ok(()) }
}

/// Every command `type` the daemon's loop actually handles. The webview can
/// only ask for one of these — an unknown/forged type is rejected here instead
/// of being piped into daemon stdin verbatim (defense in depth: the webview is
/// trusted, but a compromised page or injected artifact script shouldn't get a
/// raw line into the engine).
const ALLOWED_DAEMON_COMMANDS: &[&str] = &[
    "anthropic_login_finish", "anthropic_login_start", "bug_report",
    "openai_login_start", "openai_auth_status",
    "consciousness_cancel", "consciousness_disable", "consciousness_enable",
    "consciousness_killswitch", "consciousness_look_away", "consciousness_resume",
    "consciousness_status", "discover_custom_models", "engine_config", "exit",
    "gateway_connect", "gateway_signin", "gateway_status", "interrupt",
    "kimi_login_start", "kimi_auth_status",
    "mcp_connect", "mcp_disconnect", "mcp_list", "mcp_search", "mcp_toggle",
    "mcp_tools", "model_catalog", "model_switch", "oauth_disconnect",
    "oauth_set_credentials", "oauth_start", "oauth_status", "ollama_pull",
    "openrouter_key", "operator_autotick", "operator_control", "operator_status",
    "permission", "permission_response", "provider_key", "reasoning", "routing",
    "routing_mode", "session_delete", "session_history", "session_rename",
    "sessions_list", "set_permissions", "skill_invoke", "skill_toggle",
    "skillhub_install", "skillhub_list", "skillhub_publish", "skills_list",
    "steer", "undo", "usage_stats", "vanguard_mode", "webview_result",
];

#[tauri::command]
fn ares_daemon_command(command: Value, state: State<DaemonState>) -> Result<(), String> {
    if !command.is_object() {
        return Err("daemon command must be an object".to_string());
    }
    match command.get("type").and_then(Value::as_str) {
        Some(t) if ALLOWED_DAEMON_COMMANDS.contains(&t) => write_daemon_command(state.inner(), command),
        Some(t) => Err(format!("unknown daemon command: {t}")),
        None => Err("daemon command requires a string 'type'".to_string()),
    }
}

#[tauri::command]
fn ares_set_provider_key(
    provider: String,
    key: String,
    model: Option<String>,
    state: State<DaemonState>,
) -> Result<(), String> {
    // The owner's API key for any keyed provider (anthropic, openrouter, …).
    // Persisted to ui.json by the daemon; applied on the next daemon start.
    write_daemon_command(
        state.inner(),
        json!({ "type": "provider_key", "provider": provider, "key": key, "model": model }),
    )
}

#[tauri::command]
fn ares_set_openrouter_key(
    key: String,
    model: Option<String>,
    state: State<DaemonState>,
) -> Result<(), String> {
    // The owner's OpenRouter API key (pasted in-app). Persisted to ui.json by
    // the daemon; applied when the daemon next starts on the openrouter provider.
    write_daemon_command(
        state.inner(),
        json!({ "type": "openrouter_key", "key": key, "model": model }),
    )
}

#[tauri::command]
fn ares_permission_response(
    id: Option<String>,
    decision: String,
    state: State<DaemonState>,
) -> Result<(), String> {
    let decision = decision.trim();
    if !matches!(decision, "allow_once" | "allow_always" | "deny") {
        return Err("permission decision must be allow_once, allow_always, or deny".to_string());
    }

    write_daemon_command(
        state.inner(),
        json!({ "type": "permission_response", "id": id, "decision": decision }),
    )
}

fn write_daemon_command(state: &DaemonState, command: Value) -> Result<(), String> {
    let mut stdin_state = state.stdin.lock().map_err(|_| "daemon stdin lock failed")?;
    let stdin = stdin_state
        .as_mut()
        .ok_or_else(|| "Ares daemon is not running".to_string())?;
    let line = command.to_string();
    stdin
        .write_all(line.as_bytes())
        .and_then(|_| stdin.write_all(b"\n"))
        .and_then(|_| stdin.flush())
        .map_err(|error| format!("failed to send message to daemon: {error}"))
}

/// Write sandbox/preview HTML into the Ares home so the Forge panel can load
/// it over the asset protocol — a real document origin, so its scripts run
/// (srcdoc iframes inherit the app CSP and cannot execute inline code).
#[tauri::command]
fn ares_forge_write(name: String, html: String) -> Result<String, String> {
    let safe: String = name
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.' {
                c
            } else {
                '_'
            }
        })
        .collect();
    let safe = safe.trim_matches('.').to_string();
    if safe.is_empty() {
        return Err("forge file name is empty".to_string());
    }
    let dir = desktop_ares_home()
        .ok_or_else(|| "Ares home unavailable".to_string())?
        .join("forge");
    fs::create_dir_all(&dir).map_err(|error| format!("failed to create forge dir: {error}"))?;
    let path = dir.join(format!("{safe}.html"));
    fs::write(&path, html).map_err(|error| format!("failed to write forge file: {error}"))?;
    Ok(path.display().to_string())
}

/// Write a session/feedback log to the user's Desktop (falling back to the Ares
/// home) so it's trivial to attach and send. Returns the saved path.
#[tauri::command]
fn ares_export_log(content: String) -> Result<String, String> {
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let dir = user_desktop_dir()
        .filter(|d| d.is_dir())
        .or_else(desktop_ares_home)
        .ok_or_else(|| "no writable location for the log".to_string())?;
    fs::create_dir_all(&dir).ok();
    let path = dir.join(format!("ares-session-{stamp}.txt"));
    fs::write(&path, content).map_err(|error| format!("failed to write log: {error}"))?;
    Ok(path.display().to_string())
}

/// `ares_read_text_file` is a registered #[tauri::command] — reachable from ANY
/// JS in the webview via invoke(), not just its one current caller (HoloSpec
/// preview). Confine reads to Ares-controlled roots (the desktop workspace and
/// the Ares home/forge dir) so it can't be turned into an arbitrary-path file
/// read. Mirrors the confinement discipline resolveWorkspacePath() already
/// enforces on the TypeScript side (packages/tools/src/_shared.ts), enforced
/// here independently in the native layer.
fn allowed_read_roots() -> Vec<PathBuf> {
    let mut roots = vec![desktop_workspace_dir()];
    if let Some(home) = desktop_ares_home() {
        roots.push(home);
    }
    roots
        .into_iter()
        .filter_map(|root| fs::canonicalize(&root).ok())
        .collect()
}

#[tauri::command]
fn ares_read_text_file(path: String) -> Result<String, String> {
    let requested = PathBuf::from(path);
    let canonical = fs::canonicalize(&requested)
        .map_err(|error| format!("cannot stat file: {error}"))?;
    let roots = allowed_read_roots();
    if !roots.iter().any(|root| canonical.starts_with(root)) {
        return Err("file is outside the Ares workspace/home — refusing to read".to_string());
    }
    let meta = fs::metadata(&canonical).map_err(|error| format!("cannot stat file: {error}"))?;
    if meta.len() > 4_000_000 {
        return Err("file too large to preview".to_string());
    }
    fs::read_to_string(&canonical).map_err(|error| format!("cannot read file: {error}"))
}

#[tauri::command]
fn ares_stop_daemon(app: tauri::AppHandle, state: State<DaemonState>) -> Result<(), String> {
    stop_existing_daemon(state.inner())?;
    push_event(
        &app,
        state.inner(),
        json!({ "type": "desktop_daemon_stopped" }),
    );
    Ok(())
}

#[tauri::command]
fn ares_window_minimize(app: tauri::AppHandle) -> Result<(), String> {
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "main window unavailable".to_string())?;
    window
        .minimize()
        .map_err(|error| format!("failed to minimize window: {error}"))
}

#[tauri::command]
fn ares_window_toggle_maximize(app: tauri::AppHandle) -> Result<(), String> {
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "main window unavailable".to_string())?;
    let maximized = window
        .is_maximized()
        .map_err(|error| format!("failed to read maximize state: {error}"))?;
    if maximized {
        window
            .unmaximize()
            .map_err(|error| format!("failed to unmaximize window: {error}"))
    } else {
        window
            .maximize()
            .map_err(|error| format!("failed to maximize window: {error}"))
    }
}

#[tauri::command]
fn ares_window_close(app: tauri::AppHandle, state: State<DaemonState>) -> Result<(), String> {
    let _ = stop_existing_daemon(state.inner());
    if let Some(overlay) = app.get_webview_window("presence-overlay") {
        let _ = overlay.close();
    }
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "main window unavailable".to_string())?;
    window
        .close()
        .map_err(|error| format!("failed to close window: {error}"))
}

/// Watch the live child for unexpected exit. When it dies on its own (crash,
/// provider auth failure, OOM), clear the dead handles and tell the frontend —
/// the UI shows the failure and offers/performs a restart instead of silently
/// erroring with "pipe is being closed" on the next send.
fn spawn_exit_watcher(
    app: tauri::AppHandle,
    child: Arc<Mutex<Option<Child>>>,
    stdin: Arc<Mutex<Option<ChildStdin>>>,
    events: Arc<Mutex<Vec<BufferedEvent>>>,
    next_event_seq: Arc<AtomicU64>,
    generation: Arc<AtomicU64>,
) {
    let my_generation = generation.load(Ordering::SeqCst);
    thread::spawn(move || loop {
        thread::sleep(Duration::from_millis(500));
        if generation.load(Ordering::SeqCst) != my_generation {
            return; // superseded by a restart/stop — not ours to report
        }
        let mut exit_code: Option<i32> = None;
        let mut exited = false;
        if let Ok(mut guard) = child.lock() {
            match guard.as_mut() {
                None => return, // stopped deliberately elsewhere
                Some(proc) => match proc.try_wait() {
                    Ok(Some(status)) => {
                        exit_code = status.code();
                        exited = true;
                        *guard = None;
                    }
                    Ok(None) => {}
                    Err(_) => {
                        exited = true;
                        *guard = None;
                    }
                },
            }
        }
        if exited {
            if generation.load(Ordering::SeqCst) != my_generation {
                return;
            }
            if let Ok(mut stdin_guard) = stdin.lock() {
                *stdin_guard = None;
            }
            push_event_parts(
                &app,
                &events,
                &next_event_seq,
                json!({ "type": "desktop_daemon_exited", "code": exit_code }),
            );
            return;
        }
    });
}

/// Kill a child AND every descendant it spawned. A bare `child.kill()` on Windows
/// reaps only the direct `node` process, leaving any grandchildren (a spawned
/// garrison gateway, a Playwright browser) orphaned — which is exactly how the
/// Telegram bridge kept answering after the app "closed". `taskkill /T` walks the
/// whole tree. Best-effort everywhere; the plain kill is the cross-platform floor.
fn kill_child_tree(child: &mut Child) {
    #[cfg(windows)]
    {
        let pid = child.id();
        let _ = Command::new("taskkill")
            .args(["/F", "/T", "/PID", &pid.to_string()])
            .creation_flags(CREATE_NO_WINDOW)
            .status();
    }
    let _ = child.kill();
    let _ = child.wait();
}

fn stop_existing_daemon(state: &DaemonState) -> Result<(), String> {
    // Bump the generation first so the exit watcher treats this as deliberate.
    state.generation.fetch_add(1, Ordering::SeqCst);
    {
        let mut stdin_state = state.stdin.lock().map_err(|_| "daemon stdin lock failed")?;
        *stdin_state = None;
    }

    // Reap the Garrison gateway (and its Telegram bridge) first — same tree-kill,
    // so the bridge can never outlive the app.
    if let Ok(mut garrison_state) = state.garrison.lock() {
        if let Some(mut garrison) = garrison_state.take() {
            kill_child_tree(&mut garrison);
        }
    }

    let mut child_state = state.child.lock().map_err(|_| "daemon child lock failed")?;
    if let Some(mut child) = child_state.take() {
        kill_child_tree(&mut child);
    }
    {
        let mut provider_state = state
            .provider
            .lock()
            .map_err(|_| "daemon provider lock failed")?;
        *provider_state = None;
    }
    {
        let mut model_state = state.model.lock().map_err(|_| "daemon model lock failed")?;
        *model_state = None;
    }
    Ok(())
}

fn voice_venv_python(root: &Path) -> PathBuf {
    let venv = root.join(".ares").join("voice-venv");
    if cfg!(windows) {
        venv.join("Scripts").join("python.exe")
    } else {
        venv.join("bin").join("python")
    }
}

fn voice_log_path(root: &Path) -> PathBuf {
    root.join(".ares").join("voice-sidecar.log")
}

/// Update the voice phase and push it to the webview so the dock can narrate
/// setup progress live ("installing the voice engine…") instead of the old
/// dead-silent Stdio::null() spawn.
fn voice_emit(
    app: &tauri::AppHandle,
    phase_arc: &Arc<Mutex<(String, String)>>,
    phase: &str,
    detail: &str,
) {
    if let Ok(mut guard) = phase_arc.lock() {
        *guard = (phase.to_string(), detail.to_string());
    }
    let _ = app.emit("ares:voice-status", json!({ "phase": phase, "detail": detail }));
}

/// Find a usable system Python for bootstrapping the venv. Kokoro (the TTS
/// engine) requires >=3.10,<3.13, so interpreters in that band are tried
/// FIRST — the newest system python (3.13+) installs everything except the
/// premium voice, which is exactly the crash-looped venv we're avoiding.
fn find_system_python() -> Option<(String, Vec<String>)> {
    let candidates: &[(&str, &[&str])] = if cfg!(windows) {
        &[
            ("py", &["-3.12"] as &[&str]),
            ("py", &["-3.11"]),
            ("py", &["-3.10"]),
            ("py", &["-3"]),
            ("python", &[]),
            ("python3", &[]),
        ]
    } else {
        &[
            ("python3.12", &[] as &[&str]),
            ("python3.11", &[]),
            ("python3.10", &[]),
            ("python3", &[]),
            ("python", &[]),
        ]
    };
    for (bin, args) in candidates {
        let mut cmd = Command::new(bin);
        cmd.args(*args)
            .arg("--version")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        #[cfg(windows)]
        cmd.creation_flags(CREATE_NO_WINDOW);
        if matches!(cmd.status(), Ok(s) if s.success()) {
            return Some((bin.to_string(), args.iter().map(|a| a.to_string()).collect()));
        }
    }
    None
}

/// Run a bootstrap step with stdout/stderr appended to voice-sidecar.log so
/// failures are diagnosable (the old path discarded everything).
fn voice_run_logged(mut cmd: Command, log_path: &Path) -> bool {
    if let Ok(f) = fs::OpenOptions::new().create(true).append(true).open(log_path) {
        if let Ok(clone) = f.try_clone() {
            cmd.stdout(Stdio::from(f)).stderr(Stdio::from(clone));
        }
    }
    cmd.stdin(Stdio::null());
    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);
    matches!(cmd.status(), Ok(s) if s.success())
}

/// A hard app crash can leave Python alive after Rust loses its Child handle.
/// The next launch then reports a healthy venv, starts another server, and dies
/// with WSAEADDRINUSE forever — Repair used to repeat that exact cycle. Reclaim
/// only a listener whose command line is recognizably Ares's voice server; an
/// unrelated process on the same port is never touched.
fn reclaim_orphan_voice_server(port: u16) {
    #[cfg(windows)]
    {
        let script = format!(r#"$owners = Get-NetTCPConnection -LocalPort {} -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique; foreach ($ownerPid in $owners) {{ $p = Get-CimInstance Win32_Process -Filter "ProcessId=$ownerPid" -ErrorAction SilentlyContinue; if ($p.CommandLine -match 'voice_service[\\/]+server\.py') {{ Stop-Process -Id $ownerPid -Force -ErrorAction SilentlyContinue }} }}"#, port);
        let mut cmd = Command::new("powershell");
        cmd.args(["-NoProfile", "-NonInteractive", "-Command", &script])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        cmd.creation_flags(CREATE_NO_WINDOW);
        let _ = cmd.status();
        thread::sleep(Duration::from_millis(180));
    }
}

/// Spawn voice_service/server.py with output captured to the log, and watch
/// for unexpected exits so the UI can say "the engine died" instead of the
/// wake toggle silently sitting at offline forever.
fn spawn_voice_server(
    app: &tauri::AppHandle,
    child_arc: &Arc<Mutex<Option<Child>>>,
    phase_arc: &Arc<Mutex<(String, String)>>,
    gen_arc: &Arc<AtomicU64>,
    crash_arc: &Arc<AtomicU64>,
    root: &Path,
    port: u16,
) {
    if let Ok(guard) = child_arc.lock() {
        if guard.is_some() {
            return;
        }
    }
    reclaim_orphan_voice_server(port);
    let script = root.join("voice_service").join("server.py");
    let _ = fs::create_dir_all(root.join(".ares"));
    let log_path = voice_log_path(root);
    let venv_py = voice_venv_python(root);
    let python: std::ffi::OsString = if venv_py.exists() {
        venv_py.into_os_string()
    } else if cfg!(windows) {
        std::ffi::OsString::from("python")
    } else {
        std::ffi::OsString::from("python3")
    };
    let mut command = Command::new(python);
    command.arg(&script).current_dir(root).env("ARES_TTS_PORT", port.to_string());
    #[cfg(windows)]
    command.creation_flags(CREATE_NO_WINDOW);
    command.stdin(Stdio::null());
    match fs::OpenOptions::new().create(true).append(true).open(&log_path) {
        Ok(f) => {
            match f.try_clone() {
                Ok(clone) => {
                    command.stdout(Stdio::from(f)).stderr(Stdio::from(clone));
                }
                Err(_) => {
                    command.stdout(Stdio::null()).stderr(Stdio::from(f));
                }
            };
        }
        Err(_) => {
            command.stdout(Stdio::null()).stderr(Stdio::null());
        }
    }
    match command.spawn() {
        Ok(child) => {
            if let Ok(mut guard) = child_arc.lock() {
                *guard = Some(child);
            }
            voice_emit(app, phase_arc, "starting", "Warming up local speech…");
            let generation = gen_arc.load(Ordering::SeqCst);
            let child_watch = child_arc.clone();
            let phase_watch = phase_arc.clone();
            let gen_watch = gen_arc.clone();
            let crash_watch = crash_arc.clone();
            let app_watch = app.clone();
            let root_watch = root.to_path_buf();
            thread::spawn(move || {
              let mut healthy_since: Option<Instant> = None;
              loop {
                thread::sleep(Duration::from_millis(250));
                if gen_watch.load(Ordering::SeqCst) != generation {
                    return;
                }
                let exit_code = {
                    let mut guard = match child_watch.lock() {
                        Ok(g) => g,
                        Err(_) => return,
                    };
                    match guard.as_mut() {
                        Some(child) => match child.try_wait() {
                            Ok(Some(status)) => {
                                *guard = None;
                                Some(status.code())
                            }
                            Ok(None) => None,
                            Err(_) => return,
                        },
                        None => return,
                    }
                };
                if let Some(code) = exit_code {
                    if gen_watch.load(Ordering::SeqCst) == generation {
                        let attempt = crash_watch.fetch_add(1, Ordering::SeqCst) + 1;
                        if attempt <= 3 {
                            voice_emit(
                                &app_watch,
                                &phase_watch,
                                "starting",
                                &format!("Voice engine restarted automatically ({attempt}/3)…"),
                            );
                            thread::sleep(Duration::from_millis(650 * attempt));
                            if gen_watch.load(Ordering::SeqCst) == generation {
                                spawn_voice_server(
                                    &app_watch,
                                    &child_watch,
                                    &phase_watch,
                                    &gen_watch,
                                    &crash_watch,
                                    &root_watch,
                                    port,
                                );
                            }
                        } else {
                            voice_emit(
                                &app_watch,
                                &phase_watch,
                                "error",
                                &format!("The voice engine stopped repeatedly (exit {}). Repair will restart it without reinstalling.", code.map_or_else(|| "unknown".into(), |value| value.to_string())),
                            );
                        }
                    }
                    return;
                }

                // Do not call the engine "running" merely because Python was
                // spawned. Wait until its dynamic loopback port is actually
                // accepting connections, which prevents the wake UI flicker.
                if healthy_since.is_none() && TcpStream::connect(("127.0.0.1", port)).is_ok() {
                    healthy_since = Some(Instant::now());
                    voice_emit(&app_watch, &phase_watch, "running", "");
                }
                if healthy_since.is_some_and(|at| at.elapsed() >= Duration::from_secs(30)) {
                    crash_watch.store(0, Ordering::SeqCst);
                }
              }
            });
        }
        Err(err) => {
            voice_emit(
                app,
                phase_arc,
                "error",
                &format!("Couldn't launch the voice engine ({err}). Hit Repair to rebuild it."),
            );
        }
    }
}

/// Quick venv sanity: can it import the CORE deps the server needs to boot?
/// (kokoro is deliberately not checked — TTS degrades, the server still runs.)
fn voice_venv_healthy(root: &Path) -> bool {
    voice_import_ok(root, "import fastapi, uvicorn, numpy, faster_whisper, sounddevice")
}

/// Deep check used by Repair: is the premium TTS (kokoro) actually importable?
/// Slower (imports torch) — only run on an explicit Repair, never at startup.
fn voice_kokoro_ok(root: &Path) -> bool {
    voice_import_ok(root, "import kokoro")
}

fn voice_import_ok(root: &Path, import_line: &str) -> bool {
    let py = voice_venv_python(root);
    if !py.exists() {
        return false;
    }
    let mut cmd = Command::new(py);
    cmd.args(["-c", import_line])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);
    matches!(cmd.status(), Ok(s) if s.success())
}

/// Make voice work with zero manual steps: healthy venv → start the sidecar;
/// missing OR BROKEN venv → (re)provision in the background (venv + pip),
/// narrating progress to the UI, then start it. `force` wipes the venv first
/// (the Repair button) — a venv that half-installed (e.g. built with Python
/// 3.13, which kokoro refuses) used to crash-loop forever; now it rebuilds.
fn ensure_voice_ready(app: &tauri::AppHandle, state: &VoiceState, force: bool) {
    let Some(runtime) = resolve_ares_runtime(Some(app)) else {
        voice_emit(app, &state.phase, "missing", "Ares runtime not found — voice is unavailable.");
        return;
    };
    let root = runtime.app_root;
    let script = root.join("voice_service").join("server.py");
    if !script.exists() {
        voice_emit(
            app,
            &state.phase,
            "missing",
            "The voice service files aren't included in this install.",
        );
        return;
    }
    {
        let Ok(mut running) = state.setup_running.lock() else { return };
        if *running {
            return;
        }
        *running = true;
    }
    let app2 = app.clone();
    let child_arc = state.child.clone();
    let phase_arc = state.phase.clone();
    let gen_arc = state.generation.clone();
    let crash_arc = state.crash_count.clone();
    let setup_flag = state.setup_running.clone();
    let port = state.port;
    // Everything (including the health probe — it launches python) runs off
    // the main thread so app startup never blocks on the voice stack.
    thread::spawn(move || {
        let done = || {
            if let Ok(mut running) = setup_flag.lock() {
                *running = false;
            }
        };
        let venv_dir = root.join(".ares").join("voice-venv");
        let core_ok = voice_venv_healthy(&root);
        // Startup fast path: core deps present → just start.
        if !force && core_ok {
            voice_emit(&app2, &phase_arc, "starting", "Starting the local voice engine…");
            spawn_voice_server(&app2, &child_arc, &phase_arc, &gen_arc, &crash_arc, &root, port);
            done();
            return;
        }
        // Repair on an already-complete install (core + kokoro import fine):
        // the engine just crashed — RESTART it, don't wipe and re-download
        // gigabytes (the "hit repair → installing forever" the user hit).
        if force && core_ok && voice_kokoro_ok(&root) {
            voice_emit(&app2, &phase_arc, "starting", "Restarting the local voice engine…");
            crash_arc.store(0, Ordering::SeqCst);
            spawn_voice_server(&app2, &child_arc, &phase_arc, &gen_arc, &crash_arc, &root, port);
            done();
            return;
        }
        let _ = fs::create_dir_all(root.join(".ares"));
        let log_path = voice_log_path(&root);
        if venv_dir.exists() {
            voice_emit(&app2, &phase_arc, "setup", "Repairing the voice engine's Python environment…");
            if fs::remove_dir_all(&venv_dir).is_err() {
                voice_emit(
                    &app2,
                    &phase_arc,
                    "error",
                    "Couldn't remove the broken voice environment (.ares/voice-venv) — close anything using it, then hit Repair.",
                );
                done();
                return;
            }
        }
        voice_emit(&app2, &phase_arc, "setup", "Checking for Python (3.10–3.12 preferred)…");
        let Some((py_bin, py_args)) = find_system_python() else {
            voice_emit(
                &app2,
                &phase_arc,
                "error",
                "Python 3 isn't installed. Grab 3.12 from python.org (check “Add to PATH”), then hit Repair — Ares handles the rest.",
            );
            done();
            return;
        };
        voice_emit(&app2, &phase_arc, "setup", "Creating the voice engine's Python environment…");
        let mut venv_cmd = Command::new(&py_bin);
        venv_cmd.args(&py_args).args(["-m", "venv"]).arg(&venv_dir).current_dir(&root);
        if !voice_run_logged(venv_cmd, &log_path) {
            voice_emit(
                &app2,
                &phase_arc,
                "error",
                "Couldn't create the Python environment — see .ares/voice-sidecar.log, then hit Repair.",
            );
            done();
            return;
        }
        let mut pip_cmd = Command::new(voice_venv_python(&root));
        pip_cmd.args(["-m", "pip", "install", "--upgrade", "pip"]).current_dir(&root);
        let _ = voice_run_logged(pip_cmd, &log_path);
        // CPU-only PyTorch FIRST. kokoro depends on torch; the default index
        // pulls the ~2.5GB CUDA build (the "installing forever" the user hit).
        // The CPU wheel is ~200MB and plenty for real-time TTS on this hardware.
        // Honor ARES_VOICE_CUDA=1 for users who want the GPU build.
        if env::var("ARES_VOICE_CUDA").as_deref() != Ok("1") {
            voice_emit(&app2, &phase_arc, "setup", "Downloading the voice runtime (CPU PyTorch, ~200 MB — first run only)…");
            let mut torch_cmd = Command::new(voice_venv_python(&root));
            torch_cmd
                .args(["-m", "pip", "install", "--index-url", "https://download.pytorch.org/whl/cpu", "torch"])
                .current_dir(&root);
            let _ = voice_run_logged(torch_cmd, &log_path); // non-fatal; kokoro will pull torch if this fails
        }
        // Core (wake word + dictation + the server itself), then the premium
        // TTS separately: kokoro requires Python >=3.10,<3.13, and one refused
        // wheel must not take down the entire voice stack.
        voice_emit(
            &app2,
            &phase_arc,
            "setup",
            "Installing the voice engine (Whisper + server)…",
        );
        let mut core_cmd = Command::new(voice_venv_python(&root));
        core_cmd
            .args(["-m", "pip", "install", "fastapi>=0.115", "uvicorn[standard]>=0.30", "numpy>=1.26", "soundfile>=0.12", "faster-whisper>=1.0", "sounddevice>=0.4"])
            .current_dir(&root);
        if !voice_run_logged(core_cmd, &log_path) {
            voice_emit(
                &app2,
                &phase_arc,
                "error",
                "Installing the voice engine failed — see .ares/voice-sidecar.log, then hit Repair to retry.",
            );
            done();
            return;
        }
        voice_emit(&app2, &phase_arc, "setup", "Installing the premium voice (Kokoro TTS)…");
        let mut tts_cmd = Command::new(voice_venv_python(&root));
        tts_cmd.args(["-m", "pip", "install", "kokoro>=0.9"]).current_dir(&root);
        if !voice_run_logged(tts_cmd, &log_path) {
            // Non-fatal: wake word + dictation work; replies use the fallback voice.
            let _ = fs::OpenOptions::new().create(true).append(true).open(&log_path).map(|mut f| {
                use std::io::Write as _;
                let _ = writeln!(f, "[setup] kokoro install failed (needs Python 3.10-3.12) - continuing without premium TTS");
            });
        }
        voice_emit(&app2, &phase_arc, "starting", "Starting the local voice engine…");
        crash_arc.store(0, Ordering::SeqCst);
        spawn_voice_server(&app2, &child_arc, &phase_arc, &gen_arc, &crash_arc, &root, port);
        done();
    });
}

/// Never launch cut off: if the window is bigger than the monitor's usable
/// area (small laptop, heavy DPI scaling) shrink it to fit, and if any edge
/// ended up offscreen re-center it. Runs once at startup.
fn clamp_window_to_monitor(window: &tauri::WebviewWindow) {
    let Ok(Some(monitor)) = window.current_monitor() else { return };
    let scale = monitor.scale_factor();
    let mon_pos = *monitor.position();
    let mon_size = *monitor.size();
    // Leave room for the Windows taskbar (~48 logical px) — Monitor::size()
    // is the full panel, not the work area.
    let margin = (48.0 * scale) as i32;
    let avail_w = mon_size.width as i32;
    let avail_h = mon_size.height as i32 - margin;
    if avail_w <= 0 || avail_h <= 0 {
        return;
    }
    let Ok(mut size) = window.outer_size() else { return };
    let mut resized = false;
    if size.width as i32 > avail_w {
        size.width = avail_w as u32;
        resized = true;
    }
    if size.height as i32 > avail_h {
        size.height = avail_h as u32;
        resized = true;
    }
    if resized {
        let _ = window.set_size(tauri::PhysicalSize::new(size.width, size.height));
    }
    if let Ok(pos) = window.outer_position() {
        let out = pos.x < mon_pos.x
            || pos.y < mon_pos.y
            || pos.x + size.width as i32 > mon_pos.x + avail_w
            || pos.y + size.height as i32 > mon_pos.y + avail_h;
        if out || resized {
            let cx = mon_pos.x + ((avail_w - size.width as i32) / 2).max(0);
            let cy = mon_pos.y + ((avail_h - size.height as i32) / 2).max(0);
            let _ = window.set_position(tauri::PhysicalPosition::new(cx, cy));
        }
    }
}

fn stop_voice_sidecar(state: &VoiceState) {
    // Bump the generation FIRST so the exit-watcher knows this death is ours.
    state.generation.fetch_add(1, Ordering::SeqCst);
    if let Ok(mut guard) = state.child.lock() {
        if let Some(mut child) = guard.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

#[tauri::command]
fn ares_voice_status(app: tauri::AppHandle, state: State<VoiceState>) -> Value {
    let running = {
        match state.child.lock() {
            Ok(mut guard) => match guard.as_mut() {
                Some(child) => matches!(child.try_wait(), Ok(None)),
                None => false,
            },
            Err(_) => false,
        }
    };
    let (phase, detail) = state
        .phase
        .lock()
        .map(|g| g.clone())
        .unwrap_or_else(|_| ("idle".into(), String::new()));
    let (venv, log_path) = match resolve_ares_runtime(Some(&app)) {
        Some(runtime) => (
            voice_venv_python(&runtime.app_root).exists(),
            voice_log_path(&runtime.app_root).to_string_lossy().to_string(),
        ),
        None => (false, String::new()),
    };
    json!({
        "running": running,
        "phase": phase,
        "detail": detail,
        "venv": venv,
        "logPath": log_path,
        // The per-launch secret the webview must attach to every sidecar
        // request — the loopback-service auth gate.
        "token": state.token,
        "port": state.port,
    })
}

/// "Repair voice" — kill whatever is there, WIPE the venv, and re-provision
/// from scratch. (Respawning a half-installed venv just crash-loops again.)
#[tauri::command]
fn ares_voice_setup(app: tauri::AppHandle, state: State<VoiceState>) {
    stop_voice_sidecar(state.inner());
    ensure_voice_ready(&app, state.inner(), true);
}

fn presence_window(app: &tauri::AppHandle) -> Result<tauri::WebviewWindow, String> {
    if let Some(window) = app.get_webview_window("presence-overlay") {
        return Ok(window);
    }

    let window = tauri::WebviewWindowBuilder::new(
        app,
        "presence-overlay",
        tauri::WebviewUrl::App("index.html?presence=1".into()),
    )
    .title("Ares presence")
    .decorations(false)
    .transparent(true)
    .shadow(false)
    .resizable(false)
    .always_on_top(true)
    .skip_taskbar(true)
    .focused(false)
    .visible(false)
    .build()
    .map_err(|error| format!("failed to create presence overlay: {error}"))?;

    // The overlay is visual presence only. Mouse and keyboard input must pass
    // straight through so the user can keep working in every app underneath.
    window
        .set_ignore_cursor_events(true)
        .map_err(|error| format!("failed to make presence overlay click-through: {error}"))?;

    // Cover the monitor containing the Ares pill. Physical coordinates avoid
    // DPI seams that leave one unlit edge on mixed-scale multi-monitor setups.
    let monitor = app
        .get_webview_window("main")
        .and_then(|main| main.current_monitor().ok().flatten())
        .or_else(|| app.primary_monitor().ok().flatten());
    if let Some(monitor) = monitor {
        let _ = window.set_position(tauri::PhysicalPosition::new(
            monitor.position().x,
            monitor.position().y,
        ));
        let _ = window.set_size(tauri::PhysicalSize::new(
            monitor.size().width,
            monitor.size().height,
        ));
    }

    #[cfg(windows)]
    hide_windows_accent_border(&window);
    Ok(window)
}

#[tauri::command]
fn ares_presence_status(state: State<PresenceState>) -> PresenceSnapshot {
    state
        .snapshot
        .lock()
        .map(|snapshot| snapshot.clone())
        .unwrap_or_default()
}

#[tauri::command]
fn ares_presence_update(
    app: tauri::AppHandle,
    state: State<PresenceState>,
    mode: String,
    caption: String,
    detail: String,
) -> Result<(), String> {
    let snapshot = PresenceSnapshot {
        visible: true,
        mode,
        caption,
        detail,
    };
    if let Ok(mut current) = state.snapshot.lock() {
        *current = snapshot.clone();
    }
    let window = presence_window(&app)?;
    // Re-evaluate the monitor each time the overlay wakes in case the user
    // dragged the pill to a different display since the last voice turn.
    if let Some(monitor) = app
        .get_webview_window("main")
        .and_then(|main| main.current_monitor().ok().flatten())
    {
        let _ = window.set_position(tauri::PhysicalPosition::new(
            monitor.position().x,
            monitor.position().y,
        ));
        let _ = window.set_size(tauri::PhysicalSize::new(
            monitor.size().width,
            monitor.size().height,
        ));
    }
    window
        .show()
        .map_err(|error| format!("failed to show presence overlay: {error}"))?;
    let _ = app.emit_to("presence-overlay", "ares:presence-state", snapshot);
    Ok(())
}

#[tauri::command]
fn ares_presence_hide(app: tauri::AppHandle, state: State<PresenceState>) {
    if let Ok(mut snapshot) = state.snapshot.lock() {
        *snapshot = PresenceSnapshot::default();
    }
    if let Some(window) = app.get_webview_window("presence-overlay") {
        let _ = window.hide();
    }
}

/// Open Ares's experimental self-generating UI in its own unprivileged window.
/// The generated document itself lives in an inert iframe; this outer window
/// only owns the normal daemon/voice bridge and never exposes extra authority.
#[tauri::command]
async fn ares_living_surface_open(
    app: tauri::AppHandle,
    session_id: String,
    state: State<'_, LivingSurfaceState>,
) -> Result<(), String> {
    let session_id = session_id.trim();
    if session_id.is_empty()
        || !session_id
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '_' | '-'))
    {
        return Err("invalid Living Surface session id".to_string());
    }
    if let Ok(mut current) = state.session_id.lock() {
        *current = Some(session_id.to_string());
    }
    if let Some(existing) = app.get_webview_window("living-surface") {
        existing
            .set_focus()
            .map_err(|error| format!("failed to focus Living Surface: {error}"))?;
        return Ok(());
    }
    // Keep the asset URL deterministic and transfer the session through
    // LivingSurfaceState. On Windows this command must stay async: WebView2 can
    // otherwise create the native window but strand its renderer at about:blank.
    let webview_url = tauri::WebviewUrl::App("living.html".into());
    let window = tauri::WebviewWindowBuilder::new(
        &app,
        "living-surface",
        webview_url,
    )
    .title("Ares — Living Surface (Beta)")
    .inner_size(1380.0, 860.0)
    .min_inner_size(900.0, 620.0)
    .center()
    .background_color(tauri::utils::config::Color(5, 6, 5, 255))
    // Beta safety rail: native close/minimize controls remain available even
    // if the experimental React surface fails before its trusted chrome mounts.
    .decorations(true)
    .shadow(true)
    .resizable(true)
    .build()
    .map_err(|error| format!("failed to open Living Surface: {error}"))?;

    #[cfg(windows)]
    hide_windows_accent_border(&window);
    let close_handle = app.clone();
    window.on_window_event(move |event| {
        if matches!(event, tauri::WindowEvent::CloseRequested { .. }) {
            let _ = close_handle.emit_to("main", "ares:living-surface-closed", ());
        }
    });
    window
        .set_focus()
        .map_err(|error| format!("failed to focus Living Surface: {error}"))?;
    Ok(())
}

/// Stage the composed surface document and return the scheme URL the iframe
/// should load. The sequence number only busts the WebView's navigation cache;
/// the handler always serves the latest staged document.
#[tauri::command]
fn ares_living_surface_stage(
    document: String,
    state: State<LivingSurfaceState>,
) -> Result<String, String> {
    if document.len() > 600_000 {
        return Err("surface document exceeds the size limit".to_string());
    }
    *state
        .document
        .lock()
        .map_err(|_| "Living Surface document state is unavailable".to_string())? = Some(document);
    let seq = state.doc_seq.fetch_add(1, Ordering::SeqCst) + 1;
    // Windows and Android serve custom schemes over http://<scheme>.localhost.
    #[cfg(any(windows, target_os = "android"))]
    return Ok(format!("http://ares-surface.localhost/doc/{seq}"));
    #[cfg(not(any(windows, target_os = "android")))]
    Ok(format!("ares-surface://localhost/doc/{seq}"))
}

#[tauri::command]
fn ares_living_surface_context(state: State<LivingSurfaceState>) -> Result<String, String> {
    state
        .session_id
        .lock()
        .map_err(|_| "Living Surface session state is unavailable".to_string())?
        .clone()
        .ok_or_else(|| "Living Surface session has not been initialized".to_string())
}

#[tauri::command]
fn ares_living_surface_close(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("living-surface") {
        window
            .close()
            .map_err(|error| format!("failed to close Living Surface: {error}"))?;
    }
    let _ = app.emit_to("main", "ares:living-surface-closed", ());
    Ok(())
}

/// Renderer handshake. Classic does not collapse into the pill until this
/// arrives, so a failed surface bootstrap can never strand the owner.
#[tauri::command]
fn ares_living_surface_ready(
    app: tauri::AppHandle,
    session_id: String,
) -> Result<(), String> {
    let session_id = session_id.trim();
    if session_id.is_empty() {
        return Err("missing Living Surface session id".to_string());
    }
    app.emit_to(
        "main",
        "ares:living-surface-ready",
        json!({ "sessionId": session_id }),
    )
    .map_err(|error| format!("failed to acknowledge Living Surface: {error}"))
}

fn main() {
    // WebKitGTK's DMABUF renderer is the #1 cause of a stuttering/black-flashing
    // Tauri app on Linux (especially NVIDIA + Wayland). Disabling it falls back
    // to the stable software/GL path and makes the UI feel native. Respect an
    // explicit user override if they've already set it.
    #[cfg(all(not(windows), not(target_os = "macos")))]
    {
        if env::var("WEBKIT_DISABLE_DMABUF_RENDERER").is_err() {
            env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
        }
        // Nouveau/llvmpipe setups also hit compositing stalls; opt-in escape
        // hatch stays available: ARES_WEBKIT_COMPOSITING=1 re-enables.
        if env::var("ARES_WEBKIT_COMPOSITING").as_deref() == Ok("0") {
            env::set_var("WEBKIT_DISABLE_COMPOSITING_MODE", "1");
        }
    }
    tauri::Builder::default()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .manage(DaemonState {
            child: Arc::new(Mutex::new(None)),
            stdin: Arc::new(Mutex::new(None)),
            garrison: Arc::new(Mutex::new(None)),
            root: Mutex::new(None),
            provider: Mutex::new(None),
            model: Mutex::new(None),
            events: Arc::new(Mutex::new(Vec::new())),
            next_event_seq: Arc::new(AtomicU64::new(1)),
            generation: Arc::new(AtomicU64::new(0)),
        })
        .manage(VoiceState {
            child: Arc::new(Mutex::new(None)),
            phase: Arc::new(Mutex::new(("idle".into(), String::new()))),
            setup_running: Arc::new(Mutex::new(false)),
            generation: Arc::new(AtomicU64::new(0)),
            crash_count: Arc::new(AtomicU64::new(0)),
            token: random_token(),
            port: available_loopback_port(),
        })
        .manage(PresenceState {
            snapshot: Mutex::new(PresenceSnapshot::default()),
        })
        .manage(LivingSurfaceState {
            session_id: Mutex::new(None),
            document: Mutex::new(None),
            doc_seq: AtomicU64::new(0),
        })
        // The Living Surface's generated document. Serving it over a dedicated
        // scheme gives it its OWN Content-Security-Policy header — a srcdoc
        // iframe would inherit the app CSP and lose every generated style and
        // script in packaged builds. The window's sandbox attribute (scripts
        // without same-origin) still applies on top.
        .register_uri_scheme_protocol("ares-surface", |ctx, _request| {
            let staged = ctx
                .app_handle()
                .state::<LivingSurfaceState>()
                .document
                .lock()
                .ok()
                .and_then(|doc| doc.clone());
            match staged {
                Some(html) => tauri::http::Response::builder()
                    .header("Content-Type", "text/html; charset=utf-8")
                    .header("Content-Security-Policy", LIVING_SURFACE_CSP)
                    .header("Cache-Control", "no-store")
                    .body(html.into_bytes())
                    .unwrap_or_else(|_| tauri::http::Response::new(Vec::new())),
                None => tauri::http::Response::builder()
                    .status(404)
                    .body(Vec::new())
                    .unwrap_or_else(|_| tauri::http::Response::new(Vec::new())),
            }
        })
        .setup(|app| {
            let handle = app.handle().clone();
            #[cfg(windows)]
            if let Some(window) = app.get_webview_window("main") {
                hide_windows_accent_border(&window);
            }
            if let Some(window) = app.get_webview_window("main") {
                clamp_window_to_monitor(&window);
            }
            // Warm the transparent voice-presence surface while hidden. Its
            // first listening pulse can then appear instantly without a WebView
            // boot flash over the user's desktop.
            let _ = presence_window(app.handle());
            // Auto-start the local voice sidecar so spoken replies work out of
            // the box — provisioning the Python venv + deps itself on first
            // run, and rebuilding a broken venv automatically. The per-launch
            // auth token goes into our env so the spawned sidecar inherits it
            // and the webview can read it back via ares_voice_status.
            if let Some(voice) = app.try_state::<VoiceState>() {
                env::set_var("ARES_VOICE_TOKEN", &voice.token);
                ensure_voice_ready(&handle, voice.inner(), false);
            }
            // Only the MAIN window owns app shutdown. A global
            // `tauri://close-requested` listener also fires for the transparent
            // presence surface; closing/recreating that helper window used to
            // kill voice while the visible Ares window stayed open.
            if let Some(main) = app.get_webview_window("main") {
                let close_handle = handle.clone();
                let chrome_window = main.clone();
                main.on_window_event(move |event| {
                    // Windows can restore its active-window accent after focus
                    // or a resize (including pill mode). Reassert the frameless
                    // chrome on every focus transition so no green top strip
                    // flashes when Ares is clicked.
                    #[cfg(windows)]
                    if matches!(event, tauri::WindowEvent::Focused(_)) {
                        hide_windows_accent_border(&chrome_window);
                    }
                    if matches!(event, tauri::WindowEvent::CloseRequested { .. }) {
                        if let Some(state) = close_handle.try_state::<DaemonState>() {
                            let _ = stop_existing_daemon(state.inner());
                        }
                        if let Some(voice) = close_handle.try_state::<VoiceState>() {
                            stop_voice_sidecar(voice.inner());
                        }
                        if let Some(overlay) = close_handle.get_webview_window("presence-overlay") {
                            let _ = overlay.close();
                        }
                        close_handle.exit(0);
                    }
                });
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            ares_set_theme,
            ares_dev_mode,
            ares_ollama_models,
            ares_agent_identity,
            ares_self_model,
            ares_drain_events,
            ares_daemon_status,
            ares_start_daemon,
            ares_restart_daemon,
            ares_send,
            ares_interrupt,
            ares_set_reasoning,
            ares_set_routing,
            ares_set_openrouter_key,
            ares_set_provider_key,
            ares_daemon_command,
            ares_open_url,
            ares_open_path,
            ares_permission_response,
            ares_forge_write,
            ares_export_log,
            ares_read_text_file,
            ares_stop_daemon,
            ares_window_minimize,
            ares_window_toggle_maximize,
            ares_window_close,
            ares_voice_status,
            ares_voice_setup,
            ares_presence_status,
            ares_presence_update,
            ares_presence_hide,
            ares_living_surface_open,
            ares_living_surface_close,
            ares_living_surface_ready,
            ares_living_surface_context,
            ares_living_surface_stage
        ])
        .build(tauri::generate_context!())
        .expect("error while building Ares Tauri app")
        .run(|app_handle, event| {
            // The ONLY guaranteed cleanup hook. The `close-requested` listener and
            // the in-app close button cover the friendly path, but OS close, Alt+F4,
            // taskbar-close, and tray-quit don't go through them — and skipping
            // cleanup orphaned the daemon (and its Telegram bridge), which kept
            // answering after the app "exited". ExitRequested fires on ALL of them.
            if let tauri::RunEvent::ExitRequested { .. } = event {
                if let Some(state) = app_handle.try_state::<DaemonState>() {
                    let _ = stop_existing_daemon(state.inner());
                }
                if let Some(voice) = app_handle.try_state::<VoiceState>() {
                    stop_voice_sidecar(voice.inner());
                }
            }
        });
}

#[cfg(windows)]
fn hide_windows_accent_border(window: &tauri::WebviewWindow) {
    if let Ok(hwnd) = window.hwnd() {
        let color = DWMWA_COLOR_NONE;
        // Suppress BOTH the window border and the top caption edge. On Win11 a
        // frameless + transparent window otherwise bleeds the system accent
        // colour as a line across the very top — clearing only the border
        // leaves that top sliver, so we clear the caption colour too.
        for attr in [DWMWA_BORDER_COLOR, DWMWA_CAPTION_COLOR] {
            unsafe {
                let _ = DwmSetWindowAttribute(
                    hwnd.0 as _,
                    attr as u32,
                    &color as *const _ as *const core::ffi::c_void,
                    std::mem::size_of_val(&color) as u32,
                );
            }
        }
    }
}

fn daemon_status(state: &DaemonState) -> DaemonStatus {
    // Live-check the child rather than trusting the handle: a crashed daemon
    // must read as not-running so the shell/UI can restart it.
    let running = state
        .child
        .lock()
        .map(|mut child| match child.as_mut() {
            None => false,
            Some(proc) => match proc.try_wait() {
                Ok(Some(_)) | Err(_) => {
                    *child = None;
                    false
                }
                Ok(None) => true,
            },
        })
        .unwrap_or(false);
    status_from_locked_child(state, running)
}

/// Build a DaemonStatus from the root/provider/model locks without touching
/// state.child — for callers that already hold the child MutexGuard (e.g.
/// start_daemon()'s already-running early-return) and would deadlock on
/// std::sync::Mutex's non-reentrant lock() if they went through
/// daemon_status() instead.
fn status_from_locked_child(state: &DaemonState, running: bool) -> DaemonStatus {
    let root = state
        .root
        .lock()
        .ok()
        .and_then(|root| root.as_ref().map(|path| path.display().to_string()));
    let provider = state.provider.lock().ok().and_then(|value| value.clone());
    let model = state.model.lock().ok().and_then(|value| value.clone());
    DaemonStatus {
        running,
        root,
        provider,
        model,
    }
}

fn clean_optional(value: Option<String>) -> Option<String> {
    value
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn push_event(app: &tauri::AppHandle, state: &DaemonState, event: Value) {
    push_event_parts(app, &state.events, &state.next_event_seq, event);
}

fn push_event_parts(
    app: &tauri::AppHandle,
    events: &Arc<Mutex<Vec<BufferedEvent>>>,
    next_event_seq: &Arc<AtomicU64>,
    event: Value,
) {
    let seq = next_event_seq.fetch_add(1, Ordering::SeqCst);
    let buffered = BufferedEvent { seq, event };
    if let Ok(mut buffer) = events.lock() {
        buffer.push(buffered.clone());
        let extra = buffer.len().saturating_sub(1200);
        if extra > 0 {
            buffer.drain(0..extra);
        }
    }
    // The webview listens ONLY to ares:event-buffered (seq carries ordering +
    // catch-up). The old plain ares:event emit had zero listeners — dead, dropped.
    let _ = app.emit("ares:event-buffered", buffered);
}

/// Where a reader thread hands each parsed event. stdout routes through the
/// coalescer; stderr goes straight to push_event_parts.
type EventSink = Arc<dyn Fn(Value) + Send + Sync + 'static>;

fn spawn_output_reader<R>(reader: R, stderr: bool, sink: EventSink)
where
    R: std::io::Read + Send + 'static,
{
    thread::spawn(move || {
        for line in BufReader::new(reader).lines() {
            let Ok(line) = line else {
                break;
            };
            if stderr {
                sink(json!({ "type": "daemon_stderr", "text": line }));
                continue;
            }
            match serde_json::from_str::<serde_json::Value>(&line) {
                Ok(value) => sink(value),
                Err(_) => sink(json!({ "type": "daemon_stdout", "text": line })),
            }
        }
        sink(json!({ "type": "desktop_daemon_stream_closed" }));
    });
}

/// Accumulated run of same-kind streaming deltas awaiting a single flush.
struct PendingDelta {
    kind: &'static str,
    session: Option<String>,
    text: String,
}

/// Which streaming event types may be merged (both carry a `text` field that the
/// webview simply appends). A signatured thinking_delta is NOT merged — its
/// signature must reach the UI intact — so it's handled at the call site.
fn coalescible_kind(value: &Value) -> Option<&'static str> {
    match value.get("type").and_then(Value::as_str) {
        Some("text_delta") => Some("text_delta"),
        Some("thinking_delta") => Some("thinking_delta"),
        _ => None,
    }
}

fn flush_pending(
    app: &tauri::AppHandle,
    events: &Arc<Mutex<Vec<BufferedEvent>>>,
    next_event_seq: &Arc<AtomicU64>,
    pending: Option<PendingDelta>,
) {
    let Some(p) = pending else { return };
    if p.text.is_empty() {
        return;
    }
    let mut obj = serde_json::Map::new();
    obj.insert("type".into(), Value::String(p.kind.to_string()));
    obj.insert("text".into(), Value::String(p.text));
    if let Some(sid) = p.session {
        obj.insert("sessionId".into(), Value::String(sid));
    }
    push_event_parts(app, events, next_event_seq, Value::Object(obj));
}

/// Coalesce rapid streaming deltas into one buffered/emitted event so a fast
/// token burst becomes a handful of IPC pushes instead of hundreds. Runs of the
/// same (type, session) accumulate until a different event arrives, the size cap
/// is hit, or a short idle window elapses — then flush as a single delta. Order
/// is preserved: any non-delta (or a differing delta) flushes the pending run
/// first. Returns the Sender the stdout reader pushes parsed events into.
fn spawn_event_coalescer(
    app: tauri::AppHandle,
    events: Arc<Mutex<Vec<BufferedEvent>>>,
    next_event_seq: Arc<AtomicU64>,
) -> mpsc::Sender<Value> {
    const FLUSH_AFTER: Duration = Duration::from_millis(24);
    const MAX_BYTES: usize = 4096;
    let (tx, rx) = mpsc::channel::<Value>();
    thread::spawn(move || {
        let mut pending: Option<PendingDelta> = None;
        loop {
            match rx.recv_timeout(FLUSH_AFTER) {
                Ok(value) => match coalescible_kind(&value) {
                    Some(kind) => {
                        let session = value
                            .get("sessionId")
                            .and_then(Value::as_str)
                            .map(str::to_string);
                        let text = value.get("text").and_then(Value::as_str).unwrap_or("");
                        let signatured = value.get("signature").is_some();
                        let mergeable = !signatured
                            && pending
                                .as_ref()
                                .is_some_and(|p| p.kind == kind && p.session == session);
                        if mergeable {
                            let p = pending.as_mut().unwrap();
                            p.text.push_str(text);
                            if p.text.len() >= MAX_BYTES {
                                flush_pending(&app, &events, &next_event_seq, pending.take());
                            }
                        } else {
                            // Type/session change, or a signatured delta: flush the
                            // current run first to preserve order.
                            flush_pending(&app, &events, &next_event_seq, pending.take());
                            if signatured {
                                push_event_parts(&app, &events, &next_event_seq, value);
                            } else {
                                pending = Some(PendingDelta {
                                    kind,
                                    session,
                                    text: text.to_string(),
                                });
                            }
                        }
                    }
                    None => {
                        // A non-delta event flushes any pending deltas before it.
                        flush_pending(&app, &events, &next_event_seq, pending.take());
                        push_event_parts(&app, &events, &next_event_seq, value);
                    }
                },
                Err(mpsc::RecvTimeoutError::Timeout) => {
                    flush_pending(&app, &events, &next_event_seq, pending.take());
                }
                Err(mpsc::RecvTimeoutError::Disconnected) => {
                    flush_pending(&app, &events, &next_event_seq, pending.take());
                    break;
                }
            }
        }
    });
    tx
}

fn discover_ollama_models() -> OllamaDiscovery {
    let host = env::var("OLLAMA_HOST").unwrap_or_else(|_| "http://localhost:11434".to_string());
    let (mut models, local_root) = discover_ollama_manifests();
    let parsed = match parse_http_host(&host) {
        Some(parsed) => parsed,
        None => {
            return OllamaDiscovery {
                host,
                reachable: false,
                models,
                error: Some("OLLAMA_HOST must be an http://host:port URL".to_string()),
                local_root,
            };
        }
    };

    let tags = match http_json(&parsed, "GET", "/api/tags", None) {
        Ok(value) => value,
        Err(error) => {
            models.sort_by(|a, b| a.id.cmp(&b.id));
            return OllamaDiscovery {
                host: parsed.display,
                reachable: false,
                models,
                error: Some(error),
                local_root,
            };
        }
    };

    let mut seen = models
        .iter()
        .map(|model| model.id.clone())
        .collect::<HashSet<_>>();
    if let Some(items) = tags.get("models").and_then(|value| value.as_array()) {
        for item in items.iter().take(80) {
            let Some(id) = item
                .get("name")
                .or_else(|| item.get("model"))
                .and_then(|value| value.as_str())
                .filter(|value| !value.is_empty())
            else {
                continue;
            };
            let show = http_json(&parsed, "POST", "/api/show", Some(json!({ "model": id }))).ok();
            let api_model = ollama_model_from_api_item(id, item, show.as_ref(), &local_root);
            if seen.insert(api_model.id.clone()) {
                models.push(api_model);
            } else if let Some(existing) = models.iter_mut().find(|model| model.id == id) {
                merge_api_model(existing, api_model);
            }
        }
    }

    models.sort_by(|a, b| a.id.cmp(&b.id));
    OllamaDiscovery {
        host: parsed.display,
        reachable: true,
        models,
        error: None,
        local_root,
    }
}

fn load_agent_identity() -> AgentIdentity {
    let mut candidates = Vec::new();
    if let Ok(home) = env::var("ARES_HOME") {
        candidates.push(PathBuf::from(home).join("IDENTITY.md"));
    }
    if let Some(home) = desktop_ares_home() {
        candidates.push(home.join("IDENTITY.md"));
    }

    for path in candidates {
        if let Ok(text) = fs::read_to_string(path) {
            let name = extract_identity_field(&text, &["Name"]);
            let avatar = extract_identity_field(&text, &["Avatar", "Picture", "Icon", "Emoji"]);
            let mark =
                extract_identity_field(&text, &["Mark", "Plain-text mark", "Plain text mark"]);
            return AgentIdentity { name, avatar, mark };
        }
    }

    AgentIdentity {
        name: None,
        avatar: None,
        mark: None,
    }
}

fn load_self_model() -> Option<Value> {
    let mut candidates = Vec::new();
    if let Ok(home) = env::var("ARES_HOME") {
        candidates.push(PathBuf::from(home).join("self").join("model.json"));
    }
    if let Some(home) = desktop_ares_home() {
        candidates.push(home.join("self").join("model.json"));
    }

    for path in candidates {
        if let Ok(text) = fs::read_to_string(&path) {
            if let Ok(value) = serde_json::from_str::<Value>(&text) {
                return Some(value);
            }
        }
    }
    None
}

fn extract_identity_field(text: &str, keys: &[&str]) -> Option<String> {
    for line in text.lines() {
        let trimmed = line.trim().trim_start_matches('-').trim();
        for key in keys {
            let prefix = format!("{key}:");
            if let Some(value) = trimmed.strip_prefix(&prefix) {
                let value = value.trim().trim_matches('*').trim();
                if !value.is_empty() {
                    return Some(value.to_string());
                }
            }
        }
    }
    None
}

fn user_home_dir() -> Option<PathBuf> {
    env::var_os("USERPROFILE")
        .or_else(|| env::var_os("HOME"))
        .map(PathBuf::from)
}

fn ollama_model_from_api_item(
    id: &str,
    item: &Value,
    show: Option<&Value>,
    local_root: &Option<String>,
) -> OllamaModel {
    let details = show
        .and_then(|value| value.get("details"))
        .or_else(|| item.get("details"));
    let model_info = show.and_then(|value| value.get("model_info"));
    let family = details
        .and_then(|value| value.get("family"))
        .and_then(|value| value.as_str())
        .or_else(|| {
            model_info
                .and_then(|value| value.get("general.architecture"))
                .and_then(|value| value.as_str())
        });
    let parameters = details
        .and_then(|value| value.get("parameter_size"))
        .and_then(|value| value.as_str());
    let quant = details
        .and_then(|value| value.get("quantization_level"))
        .and_then(|value| value.as_str());
    let context = model_info
        .and_then(|value| value.get("llama.context_length"))
        .or_else(|| model_info.and_then(|value| value.get("qwen3.context_length")))
        .or_else(|| model_info.and_then(|value| value.get("gemma3.context_length")))
        .and_then(|value| value.as_u64());
    let capabilities = show
        .and_then(|value| value.get("capabilities"))
        .and_then(|value| value.as_array())
        .map(|values| string_array(values))
        .unwrap_or_default();
    let modalities = modalities_from_capabilities(&capabilities);
    let hint = hint_from_parts(family, parameters, quant);

    OllamaModel {
        id: id.to_string(),
        hint: if hint.is_empty() {
            "Local Ollama model".to_string()
        } else {
            hint
        },
        group: "local".to_string(),
        source: "local".to_string(),
        size: item.get("size").and_then(|value| value.as_u64()),
        modified_at: item
            .get("modified_at")
            .and_then(|value| value.as_str())
            .map(|value| value.to_string()),
        description: Some(local_model_description(id, family, local_root)),
        family: family.map(str::to_string),
        parameters: parameters.map(str::to_string),
        quantization: quant.map(str::to_string),
        context_window: context,
        modalities,
        capabilities,
        storage_path: local_root.clone(),
    }
}

fn merge_api_model(existing: &mut OllamaModel, api_model: OllamaModel) {
    existing.hint = api_model.hint;
    existing.size = api_model.size.or(existing.size);
    existing.modified_at = api_model
        .modified_at
        .or_else(|| existing.modified_at.clone());
    existing.description = api_model
        .description
        .or_else(|| existing.description.clone());
    existing.family = api_model.family.or_else(|| existing.family.clone());
    existing.parameters = api_model.parameters.or_else(|| existing.parameters.clone());
    existing.quantization = api_model
        .quantization
        .or_else(|| existing.quantization.clone());
    existing.context_window = api_model.context_window.or(existing.context_window);
    if !api_model.modalities.is_empty() {
        existing.modalities = api_model.modalities;
    }
    if !api_model.capabilities.is_empty() {
        existing.capabilities = api_model.capabilities;
    }
    existing.storage_path = api_model
        .storage_path
        .or_else(|| existing.storage_path.clone());
}

fn discover_ollama_manifests() -> (Vec<OllamaModel>, Option<String>) {
    let roots = ollama_model_roots();
    for root in roots {
        let manifests = root.join("manifests");
        let blobs = root.join("blobs");
        if !manifests.is_dir() {
            continue;
        }
        let mut files = Vec::new();
        collect_files(&manifests, &mut files);
        let mut models = Vec::new();
        for file in files {
            if let Some(model) = ollama_model_from_manifest(&root, &manifests, &blobs, &file) {
                models.push(model);
            }
        }
        models.sort_by(|a, b| a.id.cmp(&b.id));
        models.dedup_by(|a, b| a.id == b.id);
        return (models, Some(root.display().to_string()));
    }
    (Vec::new(), None)
}

fn ollama_model_roots() -> Vec<PathBuf> {
    let mut roots = Vec::new();
    if let Ok(value) = env::var("OLLAMA_MODELS") {
        push_model_root(&mut roots, PathBuf::from(value));
    }
    if let Ok(profile) = env::var("USERPROFILE") {
        push_model_root(
            &mut roots,
            PathBuf::from(profile).join(".ollama").join("models"),
        );
    }
    if let Ok(home) = env::var("HOME") {
        push_model_root(
            &mut roots,
            PathBuf::from(home).join(".ollama").join("models"),
        );
    }
    roots
}

fn push_model_root(roots: &mut Vec<PathBuf>, raw: PathBuf) {
    let root = if raw.join("manifests").is_dir() {
        raw
    } else if raw.join("models").join("manifests").is_dir() {
        raw.join("models")
    } else {
        raw
    };
    if root.join("manifests").is_dir() && !roots.iter().any(|item| item == &root) {
        roots.push(root);
    }
}

fn collect_files(dir: &Path, out: &mut Vec<PathBuf>) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            collect_files(&path, out);
        } else if path.is_file() {
            out.push(path);
        }
    }
}

fn ollama_model_from_manifest(
    root: &Path,
    manifests: &Path,
    blobs: &Path,
    file: &Path,
) -> Option<OllamaModel> {
    let id = model_id_from_manifest_path(manifests, file)?;
    let text = fs::read_to_string(file).ok()?;
    let manifest: Value = serde_json::from_str(&text).ok()?;
    let config_digest = manifest
        .get("config")
        .and_then(|value| value.get("digest"))
        .and_then(|value| value.as_str());
    let config = config_digest.and_then(|digest| read_blob_json(blobs, digest));
    if config
        .as_ref()
        .and_then(|value| value.get("remote_host"))
        .and_then(|value| value.as_str())
        .is_some()
        || id.contains("-cloud")
        || id.ends_with(":cloud")
    {
        return None;
    }

    let size = manifest
        .get("layers")
        .and_then(|value| value.as_array())
        .map(|layers| {
            layers
                .iter()
                .filter_map(|layer| layer.get("size").and_then(|value| value.as_u64()))
                .sum()
        });
    let family = config
        .as_ref()
        .and_then(|value| value.get("model_family"))
        .and_then(|value| value.as_str());
    let parameters = config
        .as_ref()
        .and_then(|value| value.get("model_type"))
        .and_then(|value| value.as_str());
    let quant = config
        .as_ref()
        .and_then(|value| value.get("file_type"))
        .and_then(|value| value.as_str());
    let context = config
        .as_ref()
        .and_then(|value| value.get("context_length"))
        .and_then(|value| value.as_u64());
    let capabilities = config
        .as_ref()
        .and_then(|value| value.get("capabilities"))
        .and_then(|value| value.as_array())
        .map(|values| string_array(values))
        .unwrap_or_else(|| vec!["completion".to_string()]);
    let modalities = modalities_from_capabilities(&capabilities);
    let modified_at = fs::metadata(file)
        .ok()
        .and_then(|meta| meta.modified().ok())
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_secs().to_string());
    let hint = hint_from_parts(family, parameters, quant);

    Some(OllamaModel {
        id: id.clone(),
        hint: if hint.is_empty() {
            "Local manifest model".to_string()
        } else {
            hint
        },
        group: "local".to_string(),
        source: "local".to_string(),
        size,
        modified_at,
        description: Some(local_model_description(
            &id,
            family,
            &Some(root.display().to_string()),
        )),
        family: family.map(str::to_string),
        parameters: parameters.map(str::to_string),
        quantization: quant.map(str::to_string),
        context_window: context,
        modalities,
        capabilities,
        storage_path: Some(root.display().to_string()),
    })
}

fn model_id_from_manifest_path(manifests: &Path, file: &Path) -> Option<String> {
    let rel = file.strip_prefix(manifests).ok()?;
    let parts = rel
        .iter()
        .map(|part| part.to_string_lossy().to_string())
        .collect::<Vec<_>>();
    if parts.len() < 4 {
        return None;
    }
    let namespace = &parts[1];
    let name = &parts[2];
    let tag = parts.last()?;
    if namespace == "library" {
        Some(format!("{name}:{tag}"))
    } else {
        Some(format!("{namespace}/{name}:{tag}"))
    }
}

fn read_blob_json(blobs: &Path, digest: &str) -> Option<Value> {
    let file = digest.replace(':', "-");
    let text = fs::read_to_string(blobs.join(file)).ok()?;
    serde_json::from_str(&text).ok()
}

fn hint_from_parts(family: Option<&str>, parameters: Option<&str>, quant: Option<&str>) -> String {
    [family, parameters, quant]
        .into_iter()
        .flatten()
        .filter(|value| !value.is_empty())
        .collect::<Vec<_>>()
        .join(" / ")
}

fn string_array(values: &[Value]) -> Vec<String> {
    values
        .iter()
        .filter_map(|value| value.as_str())
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .collect()
}

fn modalities_from_capabilities(capabilities: &[String]) -> Vec<String> {
    let mut modalities = vec!["Text".to_string()];
    if capabilities
        .iter()
        .any(|item| item.contains("vision") || item.contains("image"))
    {
        modalities.push("Image".to_string());
    }
    if capabilities.iter().any(|item| item.contains("tools")) {
        modalities.push("Tools".to_string());
    }
    modalities
}

fn local_model_description(id: &str, family: Option<&str>, local_root: &Option<String>) -> String {
    let root = local_root
        .as_deref()
        .unwrap_or("the local Ollama model store");
    let family = family.unwrap_or_else(|| id.split(':').next().unwrap_or("local"));
    format!("{id} is installed locally under {root}. It runs through the Ollama daemon with no cloud token spend; Ares uses it as an offline {family} model when selected.")
}

struct ParsedHttpHost {
    display: String,
    connect_host: String,
    host_header: String,
    port: u16,
}

fn parse_http_host(raw: &str) -> Option<ParsedHttpHost> {
    let trimmed = raw.trim().trim_end_matches('/');
    let without_scheme = trimmed
        .strip_prefix("http://")
        .or_else(|| trimmed.strip_prefix("HTTP://"))
        .unwrap_or(trimmed);
    if without_scheme.starts_with("https://") || without_scheme.contains('/') {
        return None;
    }
    let (host, port) = if let Some((host, port)) = without_scheme.rsplit_once(':') {
        (host.to_string(), port.parse::<u16>().ok()?)
    } else {
        (without_scheme.to_string(), 11434)
    };
    if host.is_empty() {
        return None;
    }
    let connect_host = match host.as_str() {
        "0.0.0.0" | "::" | "[::]" => "127.0.0.1".to_string(),
        "localhost" => "127.0.0.1".to_string(),
        _ => host.clone(),
    };
    Some(ParsedHttpHost {
        display: format!("http://{}:{}", host, port),
        connect_host,
        host_header: host,
        port,
    })
}

fn http_json(
    host: &ParsedHttpHost,
    method: &str,
    path: &str,
    body: Option<Value>,
) -> Result<Value, String> {
    let body_text = body.map(|value| value.to_string()).unwrap_or_default();
    let address = (host.connect_host.as_str(), host.port)
        .to_socket_addrs()
        .map_err(|error| format!("failed to resolve Ollama host: {error}"))?
        .next()
        .ok_or_else(|| "failed to resolve Ollama host".to_string())?;
    let mut stream = TcpStream::connect_timeout(&address, Duration::from_millis(900))
        .map_err(|error| format!("Ollama not reachable: {error}"))?;
    let _ = stream.set_read_timeout(Some(Duration::from_millis(1_200)));
    let _ = stream.set_write_timeout(Some(Duration::from_millis(1_200)));
    let request = if body_text.is_empty() {
        format!(
            "{method} {path} HTTP/1.1\r\nHost: {}\r\nAccept: application/json\r\nConnection: close\r\n\r\n",
            host.host_header,
        )
    } else {
        format!(
            "{method} {path} HTTP/1.1\r\nHost: {}\r\nAccept: application/json\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
            host.host_header,
            body_text.len(),
            body_text,
        )
    };
    stream
        .write_all(request.as_bytes())
        .map_err(|error| format!("failed to query Ollama: {error}"))?;
    let mut response = String::new();
    stream
        .read_to_string(&mut response)
        .map_err(|error| format!("failed to read Ollama response: {error}"))?;
    let (head, body) = response
        .split_once("\r\n\r\n")
        .ok_or_else(|| "invalid Ollama HTTP response".to_string())?;
    // Ollama answers HTTP/1.1 with Transfer-Encoding: chunked — the body is
    // chunk-size lines interleaved with data. Decode before parsing JSON.
    let body = if head.to_ascii_lowercase().contains("transfer-encoding: chunked") {
        decode_chunked_body(body)
    } else {
        body.to_string()
    };
    serde_json::from_str(&body).map_err(|error| format!("invalid Ollama JSON: {error}"))
}

fn decode_chunked_body(raw: &str) -> String {
    // Chunk sizes are BYTE counts — work on bytes so a chunk boundary inside a
    // multibyte character can never panic a string slice.
    let bytes = raw.as_bytes();
    let mut out: Vec<u8> = Vec::new();
    let mut pos = 0usize;
    while pos + 1 < bytes.len() {
        let Some(line_end) = bytes[pos..]
            .windows(2)
            .position(|w| w == b"\r\n")
            .map(|i| pos + i)
        else {
            break;
        };
        let size_line = String::from_utf8_lossy(&bytes[pos..line_end]);
        let size = usize::from_str_radix(size_line.trim().split(';').next().unwrap_or(""), 16).unwrap_or(0);
        let data_start = line_end + 2;
        if size == 0 || data_start + size > bytes.len() {
            break;
        }
        out.extend_from_slice(&bytes[data_start..data_start + size]);
        pos = data_start + size + 2;
    }
    String::from_utf8_lossy(&out).to_string()
}

fn resolve_ares_runtime(app: Option<&tauri::AppHandle>) -> Option<AresRuntime> {
    if let Some(app) = app {
        if let Some(runtime) = bundled_runtime(app) {
            return Some(runtime);
        }
    }

    if let Ok(root) = env::var("ARES_ROOT") {
        if let Some(found) = cli_in_root(Path::new(&root)) {
            return Some(found);
        }
    }

    let mut starts = Vec::new();
    if let Ok(current) = env::current_dir() {
        starts.push(current);
    }
    if let Ok(exe) = env::current_exe() {
        if let Some(parent) = exe.parent() {
            starts.push(parent.to_path_buf());
        }
    }

    for start in starts {
        for ancestor in start.ancestors() {
            if let Some(found) = cli_in_root(ancestor) {
                return Some(found);
            }
        }
    }

    None
}

fn bundled_runtime(app: &tauri::AppHandle) -> Option<AresRuntime> {
    let mut candidates = Vec::new();
    if let Ok(resource_dir) = app.path().resource_dir() {
        push_runtime_candidates(&mut candidates, resource_dir);
    }
    if let Ok(exe) = env::current_exe() {
        if let Some(parent) = exe.parent() {
            push_runtime_candidates(&mut candidates, parent.to_path_buf());
        }
    }

    let mut seen = HashSet::new();
    for root in candidates {
        if seen.insert(root.clone()) {
            if let Some(runtime) = runtime_at(&root) {
                return Some(runtime);
            }
        }
    }
    None
}

fn push_runtime_candidates(candidates: &mut Vec<PathBuf>, root: PathBuf) {
    candidates.push(root.join("runtime"));
    candidates.push(root);
}

/// Strip Windows verbatim prefixes (`\\?\` / `\\?\UNC\`). Tauri's
/// resource_dir() returns canonicalized verbatim paths, and Node CANNOT load
/// its main module through one — realpathSync walks the components, lstats a
/// bare `C:`, and dies with EISDIR before the daemon even starts.
fn simplify_path(path: &Path) -> PathBuf {
    let text = path.to_string_lossy();
    if let Some(rest) = text.strip_prefix(r"\\?\UNC\") {
        PathBuf::from(format!(r"\\{rest}"))
    } else if let Some(rest) = text.strip_prefix(r"\\?\") {
        PathBuf::from(rest)
    } else {
        path.to_path_buf()
    }
}

fn runtime_at(root: &Path) -> Option<AresRuntime> {
    let root = simplify_path(root);
    let cli = root.join("cli").join("ares-cli.mjs");
    let node = root
        .join("bin")
        .join(if cfg!(windows) { "node.exe" } else { "node" });
    if cli.exists() && node.exists() {
        return Some(AresRuntime {
            app_root: root.to_path_buf(),
            cli_entry: cli,
            node,
            workspace: desktop_workspace_dir(),
        });
    }
    None
}

fn cli_in_root(root: &Path) -> Option<AresRuntime> {
    let cli = root
        .join("packages")
        .join("cli")
        .join("dist")
        .join("entry.js");
    if cli.exists() {
        Some(AresRuntime {
            app_root: root.to_path_buf(),
            cli_entry: cli,
            node: PathBuf::from("node"),
            workspace: env::var("ARES_WORKSPACE")
                .map(PathBuf::from)
                .unwrap_or_else(|_| root.to_path_buf()),
        })
    } else {
        None
    }
}

fn desktop_workspace_dir() -> PathBuf {
    if let Ok(value) = env::var("ARES_WORKSPACE") {
        return PathBuf::from(value);
    }
    user_desktop_dir()
        .unwrap_or_else(|| user_home_dir().unwrap_or_else(|| PathBuf::from(".")))
        .join("Ares Workspace")
}

fn desktop_ares_home() -> Option<PathBuf> {
    if let Ok(value) = env::var("ARES_HOME") {
        return Some(PathBuf::from(value));
    }
    user_config_dir()
        .or_else(|| user_home_dir().map(|home| home.join(".config")))
        .map(|dir| dir.join("Ares").join("home"))
}

fn desktop_ares_home_string() -> String {
    desktop_ares_home()
        .unwrap_or_else(|| PathBuf::from(".ares-home"))
        .display()
        .to_string()
}

fn user_desktop_dir() -> Option<PathBuf> {
    user_home_dir().map(|home| home.join("Desktop"))
}

fn user_config_dir() -> Option<PathBuf> {
    if let Ok(value) = env::var("APPDATA") {
        return Some(PathBuf::from(value));
    }
    if let Ok(value) = env::var("XDG_CONFIG_HOME") {
        return Some(PathBuf::from(value));
    }
    user_home_dir().map(|home| {
        if cfg!(target_os = "macos") {
            home.join("Library").join("Application Support")
        } else {
            home.join(".config")
        }
    })
}
