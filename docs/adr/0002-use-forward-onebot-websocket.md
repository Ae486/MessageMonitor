# Use a forward OneBot WebSocket

QQ Message Monitor acts as a WebSocket client and connects to the Message Bridge's OneBot 11 WebSocket server. Connection state plus verified `self_id` is the authority for capture availability; Windows QQ process monitoring and a reverse WebSocket server were rejected because they add platform or server lifecycle complexity without improving account identity correctness.
