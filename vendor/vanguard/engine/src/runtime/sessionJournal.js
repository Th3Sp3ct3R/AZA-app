export async function appendSessionEvent(journal, type, data) {
    const tip = await journal.tip();
    await journal.append({ sequence: tip.sequence + 1, type, data });
}
