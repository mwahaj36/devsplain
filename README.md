# devsplain

![devsplain demo](sample.gif)

An agent-agnostic CLI tool that automatically adds JSDoc and inline comments to your code using free LLMs.

Tired of writing documentation? Let AI do the explaining for you. `devsplain` reads your code and intelligently injects standard JSDoc headers and inline comments.

## Installation & Usage

You can run `devsplain` instantly without installing anything using `npx`:

```bash
npx devsplain src/utils.js
```

Alternatively, if you use it often, you can install it globally on your machine:

```bash
npm install -g devsplain
devsplain src/utils.js
```

### Directory Support (Bulk Processing)

You don't have to go file-by-file! Point `devsplain` at an entire directory, and it will recursively crawl through your codebase and comment everything.

```bash
devsplain src/
```

_Note: `devsplain` is smart. It automatically ignores junk folders like `node_modules`, `.git`, `dist`, `venv`, and `.next` to save you time and API tokens._

### Modes

You can control exactly how aggressive the AI is with its comments using flags:

- `--light`: Only adds JSDoc blocks above functions. Keeps the inside of your functions completely untouched.
- `--full`: Highly aggressive. Explains complex logic line-by-line inside your functions.
- `--clean`: A code scrubber. Removes ALL existing comments from the code, leaving it completely bare.
- `--dry-run`: Interactive preview. Prints the AI's output to the terminal and waits for your approval before saving to the file. Extremely safe for testing!
- **(Default)**: A balanced mix of JSDoc headers and sparse inline comments for complex logic.

**Usage Examples:**

```bash
devsplain src/utils.js --light
devsplain src/ --full
devsplain legacy_code.js --clean
devsplain lib/ --dry-run
```

### Supported Languages

Because `devsplain` uses LLMs, it natively understands almost every language syntax. It currently processes the following extensions:

- **Web**: `.js`, `.jsx`, `.ts`, `.tsx`, `.html`, `.css`, `.scss`, `.vue`, `.svelte`
- **Backend**: `.py`, `.java`, `.c`, `.cpp`, `.cs`, `.go`, `.rb`, `.php`, `.rs`
- **Mobile/Scripts**: `.swift`, `.kt`, `.dart`, `.sh`

## Agent Agnostic (Bring Your Own LLM)

`devsplain` doesn't lock you into one ecosystem. On your first run, an interactive Setup Wizard will ask you which engine you want to use:

1. **Groq** (Recommended) - Instant, free Llama-3 endpoints.
2. **Gemini** - Google's free tier endpoints.
3. **OpenAI** - Standard paid ChatGPT models.
4. **Custom** - Point it at ANY OpenAI-compatible endpoint (e.g., local models via Ollama or LMStudio).

_(Your configuration is safely stored in `~/.devsplainrc` on your machine)._

---

### Disclaimer

**Use at your own risk.** `devsplain` uses AI to physically overwrite your source files. While the prompts are heavily engineered to prevent code refactoring or corruption, AI is non-deterministic. **Always ensure your code is committed to Git (Version Control) before running `devsplain` on an entire directory!** We are not responsible for corrupted or lost code.

## License

MIT
