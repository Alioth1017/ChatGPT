# Change Log

All notable changes to the "ocursor" extension will be documented in this file.

Check [Keep a Changelog](http://keepachangelog.com/) for recommendations on how to structure this file.

## [0.0.2] - 2026-07-05

### Added

- Per-workspace conversations (existing global conversations migrate automatically)
- GGUF models auto-load on first message with a "loading model" card in chat
- llama.cpp server uses random free ports with retry on bind failure

### Changed

- Composer dropdowns (model picker, mode menu) now position themselves within the viewport and work in edit mode
- All composers share one selected model and mode
- Auto model selection hidden for now; first enabled model is the default

### Fixed

- Production error: `Cannot find package '@huggingface/hub'` (runtime deps now resolved via file URLs)

### Removed

- MCP tool marketplace

## [0.0.1] - 2026-07-05

### Added

- Initial release
- Agent chat sidebar with multi-turn conversations and streaming responses
- Tool suite: file read/write/edit, glob/grep search, shell commands, web search/fetch
- Local model providers: Ollama and llama.cpp, plus OAuth-based cloud providers
- Semantic codebase index for meaning-based search
- MCP (Model Context Protocol) client with external server support
- Approval policy engine with allow/ask/deny rules per tool (shell, edits, web, MCP)
- Inline diff review for AI-proposed edits
- Context mentions, workspace context, and custom rules/hooks
- Settings panel (React webview) for models, features, and approval configuration
- `Ctrl+L` / `Cmd+L` to add editor selection to chat
