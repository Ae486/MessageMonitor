# Use an external message bridge

QQ Message Monitor consumes a separately installed and operated OneBot-compatible bridge, with LLOneBot as the first supported provider (see ADR-0004). The MCP does not bundle, download, launch, or depend on any bridge's internals; this adds an external runtime prerequisite while keeping QQ integration, account login, and version-specific adaptation outside the monitor.
