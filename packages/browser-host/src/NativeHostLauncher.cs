using System;
using System.Diagnostics;
using System.IO;
using System.Threading.Tasks;

public static class NativeHostLauncher {
  private const int MaxNativeMessage = 4 * 1024 * 1024;

  private static bool ReadExact(Stream input, byte[] buffer, int count) {
    int offset = 0;
    while (offset < count) {
      int read = input.Read(buffer, offset, count - offset);
      if (read <= 0) return false;
      offset += read;
    }
    return true;
  }

  private static void PumpNativeMessages(Stream input, Stream output) {
    byte[] header = new byte[4];
    while (ReadExact(input, header, header.Length)) {
      int length = BitConverter.ToInt32(header, 0);
      if (length < 0 || length > MaxNativeMessage) throw new InvalidDataException("native message exceeds limit");
      byte[] payload = new byte[length];
      if (!ReadExact(input, payload, payload.Length)) return;
      output.Write(header, 0, header.Length);
      output.Write(payload, 0, payload.Length);
      output.Flush();
    }
  }

  private static string ReadString(string json, string name) {
    string marker = "\"" + name + "\"";
    int key = json.IndexOf(marker, StringComparison.Ordinal);
    if (key < 0) return null;
    int colon = json.IndexOf(':', key + marker.Length);
    int quote = json.IndexOf('"', colon + 1);
    int end = quote + 1;
    bool escape = false;
    for (; end < json.Length; end++) {
      char c = json[end];
      if (c == '"' && !escape) break;
      escape = c == '\\' && !escape;
      if (c != '\\') escape = false;
    }
    return System.Text.RegularExpressions.Regex.Unescape(json.Substring(quote + 1, end - quote - 1));
  }

  public static int Main(string[] args) {
    try {
      // Chrome launches native hosts without ARES_HOME. The installer places
      // this executable beside config.json, so resolve that location first.
      // The old ~/.ares-only lookup made the host exit immediately for desktop
      // installs, whose real home is %APPDATA%\Ares\home.
      string configPath = Path.Combine(AppContext.BaseDirectory, "config.json");
      string home = Environment.GetEnvironmentVariable("ARES_HOME");
      if (!File.Exists(configPath) && !String.IsNullOrWhiteSpace(home)) {
        configPath = Path.Combine(home, "browser-bridge", "config.json");
      }
      if (!File.Exists(configPath)) {
        home = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "Ares", "home");
        configPath = Path.Combine(home, "browser-bridge", "config.json");
      }
      if (!File.Exists(configPath)) {
        home = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".ares");
        configPath = Path.Combine(home, "browser-bridge", "config.json");
      }
      if (!File.Exists(configPath)) throw new FileNotFoundException("Ares browser bridge config missing", configPath);
      string bridgeDir = Path.GetDirectoryName(configPath);
      home = Directory.GetParent(bridgeDir).FullName;
      string json = File.ReadAllText(configPath);
      string target = ReadString(json, "target");
      string host = Path.Combine(target, "packages", "browser-host", "src", "host.mjs");
      string node = ReadString(json, "nodePath");
      string configuredNode = Environment.GetEnvironmentVariable("ARES_NODE");
      if (!String.IsNullOrWhiteSpace(configuredNode)) node = configuredNode;
      if (String.IsNullOrWhiteSpace(node)) node = "node.exe";
      var process = new Process();
      process.StartInfo = new ProcessStartInfo(node, "\"" + host + "\"") {
        UseShellExecute = false,
        CreateNoWindow = true,
        // Chrome owns this launcher's stdio pipes. Explicitly proxy them to the
        // Node child; relying on inherited handles leaves Chrome waiting forever
        // for a native-messaging response on some Windows/.NET combinations.
        RedirectStandardInput = true,
        RedirectStandardOutput = true,
        RedirectStandardError = true,
      };
      process.StartInfo.EnvironmentVariables["ARES_HOME"] = home;
      process.StartInfo.EnvironmentVariables["ARES_BROWSER_BRIDGE_CONFIG"] = configPath;
      process.Start();
      Stream chromeIn = Console.OpenStandardInput();
      Stream chromeOut = Console.OpenStandardOutput();
      Stream chromeErr = Console.OpenStandardError();
      Task input = Task.Run(() => {
        try {
          PumpNativeMessages(chromeIn, process.StandardInput.BaseStream);
          process.StandardInput.Close();
        } catch (IOException) { }
      });
      Task output = Task.Run(() => {
        try {
          PumpNativeMessages(process.StandardOutput.BaseStream, chromeOut);
        } catch (IOException) { }
      });
      Task errors = Task.Run(() => {
        try {
          process.StandardError.BaseStream.CopyTo(chromeErr);
          chromeErr.Flush();
        } catch (IOException) { }
      });
      process.WaitForExit();
      Task.WaitAll(new Task[] { output, errors }, 2000);
      return process.ExitCode;
    } catch (Exception error) {
      Console.Error.WriteLine(error.ToString());
      return 1;
    }
  }
}
