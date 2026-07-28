export class FixedCommandTool {
    name;
    processTool;
    command;
    definition;
    constructor(name, description, processTool, command) {
        this.name = name;
        this.processTool = processTool;
        this.command = command;
        this.definition = {
            name,
            description,
            inputSchema: { type: "object", additionalProperties: true },
            effect: "execute",
            evidenceAuthority: "independent-execution",
        };
    }
    async execute(_input, context) {
        return this.processTool.execute({
            command: this.command.command,
            args: [...this.command.args],
            ...(this.command.cwd === undefined ? {} : { cwd: this.command.cwd }),
        }, context);
    }
}
