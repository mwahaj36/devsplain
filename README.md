# devsplain

An agent-agnostic CLI tool that automatically adds JSDoc and inline comments to your code using free LLMs.

Tired of writing documentation? Let AI do the explaining for you. `devsplain` reads your code and intelligently injects standard JSDoc headers and inline comments.

## Installation

Install it globally via npm:

```bash
npm install -g devsplain
```

## Usage

Simply point `devsplain` at any file you want to comment:

```bash
devsplain src/utils.js
```

### Modes

You can control exactly how aggressive the AI is with its comments using flags:

- `--light`: Only adds JSDoc blocks above functions. Keeps the inside of your functions completely untouched.
- `--full`: Highly aggressive. Explains complex logic line-by-line inside your functions.
- **(Default)**: A balanced mix of JSDoc headers and sparse inline comments for complex logic.

Example:

```bash
devsplain src/utils.js --light
```

### Samples in this Repository

To see exactly what `devsplain` can do, the source code of this very repository was commented using the tool itself (using the Groq provider):

- `bin/cli.js`: Commented using the **Default** mode.
- `lib/config.js`: Commented using the **--light** mode.
- `lib/llm.js`: Commented using the **--full** mode.

## Agent Agnostic (Bring Your Own LLM)

`devsplain` doesn't lock you into one ecosystem. On your first run, an interactive Setup Wizard will ask you which engine you want to use:

1. **Groq** (Recommended) - Instant, free Llama-3 endpoints.
2. **Gemini** - Google's free tier endpoints.
3. **OpenAI** - Standard paid ChatGPT models.
4. **Custom** - Point it at ANY OpenAI-compatible endpoint (e.g., local models via Ollama or LMStudio).

_(Your configuration is safely stored in `~/.devsplainrc` on your machine)._

## License

MIT
