# QQ Message Monitor

QQ Message Monitor captures selected QQ conversations and exposes them as read-only context for a companion agent.

## Language

**Target Account**:
The single QQ account whose configured UIN must match the message bridge's `self_id` before capture becomes active.
_Avoid_: Bot account, process account

**Owner**:
The person represented by the Target Account. Messages sent by that account are captured like other messages and marked as owner messages.
_Avoid_: Bot, administrator

**Message Bridge**:
An external runtime that exposes messages from an active QQ account through a compatible event and query interface. LLOneBot attached to the Owner's daily official QQ client is the first supported bridge; NapCat remains protocol-compatible but unverified, and QQ Message Monitor stays independent of any bridge's internal code and storage.
_Avoid_: Embedded bot, dedicated headless QQ, NapCat package

**Bridge Session**:
An authenticated connection to a Message Bridge whose reported account identity has been verified as the Target Account. Its availability is authoritative for starting and stopping message capture.
_Avoid_: QQ process, socket alone

**Monitored Conversation**:
A group or friend conversation whose messages are captured according to the active account's monitoring rules.
_Avoid_: Chat target, monitored user

**Message Projection**:
A readable text representation of a captured structured QQ message used by the agent and summarization. Unsupported media remains represented by descriptive placeholders until richer processing is available.
_Avoid_: Raw message, transcription

**Monitoring Baseline**:
The point at which a target account is first successfully observed through its message bridge. Messages before this point are outside the monitor's expected coverage.
_Avoid_: Imported history, account creation time

**Capture Gap**:
An interval after the monitoring baseline for which complete message capture could not be confirmed. The gap is disclosed rather than treated as complete history.
_Avoid_: Summary gap, empty conversation

**Recalled Message**:
A captured message later identified as withdrawn by a matching recall notice from the message bridge. It remains within its original message and summary boundaries even when its content is hidden.
_Avoid_: Deleted message, missing message

**Summary Threshold**:
The configured number of unsummarized messages in a monitored conversation required to start background summarization.
_Avoid_: Idle threshold, summary interval

**Summary Producer**:
The independently configured model service that creates summaries in the background. It is separate from both the companion agent and the message bridge.
_Avoid_: Agent, NapCat, MCP client

**Factual Summary**:
A summary limited to claims supported by its source messages. Optional categories are left empty when absent rather than filled with inferred decisions, unresolved questions, owner relevance, or relationship judgments.
_Avoid_: Character profile, relationship assessment, speculative interpretation

**Summary Dimension**:
A user-configured named aspect that a factual summary may extract from its source messages, together with instructions describing what qualifies. A dimension remains empty when its requested information is absent.
_Avoid_: Hard-coded summary field, required finding

**Summary Finding**:
A factual text entry produced for one summary dimension and linked to the source messages that support it. All configured dimensions use this same entry form.
_Avoid_: Unsupported observation, free-form field value

**Summary Reference**:
A short local identifier that lets the agent retrieve a summary unit, summary finding, or supporting message without supplying source message identifiers or reconstructing conversation coordinates.
_Avoid_: OneBot message ID, compound lookup parameters

**Summary Schema Snapshot**:
The summary dimensions and instructions in effect when a summary unit is created. Completed units retain their snapshot and are not automatically regenerated when later configuration changes.
_Avoid_: Current summary configuration, mutable summary schema

**Feed Progress**:
The point through which the agent has received the index of changed monitored conversations. It does not mean the agent has read those conversations.
_Avoid_: Conversation read progress

**Feed Update**:
A change that should be surfaced after Feed Progress, including new messages, summary completion or failure, recalls, and capture gaps.
_Avoid_: Unread message, notification popup

**Conversation Read Progress**:
The point through which the agent has retrieved the content of one monitored conversation. It advances independently from feed progress.
_Avoid_: Feed progress, QQ client unread state

**Read Acknowledgement**:
An explicit local decision to advance one conversation's read progress without retrieving its content. It does not alter the QQ client's unread state.
_Avoid_: QQ read receipt, feed acknowledgement

**Summary Unit**:
A bounded, consecutive message set from one monitored conversation together with the summary derived from exactly that set. Its message boundary is fixed when summarization starts, and the message set and summary are managed as one unit for retrieval, retention, and later grouping.
_Avoid_: Summary text, message batch, archive

**Preceding Summary Context**:
The completed summary immediately before a summary unit in the same conversation, supplied only to preserve continuity while interpreting the current unit. It provides context but is not part of the current unit's covered message set.
_Avoid_: Previous messages, overlapping summary

**Summary Gap**:
A summary unit whose summary could not be produced after all permitted attempts. Its message boundary remains recorded, but the next unit may proceed without preceding summary context.
_Avoid_: Missing messages, skipped conversation

**Summary-Only Unit**:
A completed summary unit retained after its source messages have expired. It preserves the summary and coverage metadata but no longer supports retrieval of the original messages.
_Avoid_: Complete summary unit, archived messages
