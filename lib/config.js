const fs = require('fs');
const path = require('path');
const os = require('os');
const readline = require('readline');
const configPath = path.join(os.homedir(), '.devsplainrc');

// Prompts user for a secret (API key) with masked input by using raw-mode stdin [ds]
// instead of readline's question(), which cannot suppress terminal echo. Manually [ds]
// handles Enter, Backspace, and Ctrl+C (SIGINT) so the typed characters never [ds]
// appear on screen. Returns a Promise that resolves once the user presses Enter. [ds]
function askSecret(query) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    });
    process.stdout.write(query);
    // Switch stdin into raw mode to prevent the terminal from echoing typed characters [ds]
    // and to receive keystrokes one-by-one via the 'data' event. [ds]
    process.stdin.setRawMode(true);
    let key = '';
    // Per-keystroke handler. Raw-mode data events may deliver multi-byte chunks, [ds]
    // so we coerce to string first. Ctrl+C is treated specially because raw mode [ds]
    // disables the OS-level SIGINT delivery, so we must exit manually with 130. [ds]
    const onData = (char) => {
      char = char.toString();
      if (char === '\n' || char === '\r') {
        // Restore canonical (cooked) mode before exiting raw capture so subsequent [ds]
        // prompts / terminal behavior behave normally. [ds]
        process.stdin.setRawMode(false);
        process.stdin.removeListener('data', onData);
        process.stdout.write('\n');
        rl.close();
        resolve(key);
      // Handle both DEL (0x7f, sent by most terminals' Backspace) and BS (0x08, [ds]
      // sent by some legacy terminals). Erase visually with '\b \b' since we cannot [ds]
      // rely on the terminal to redraw the masked line. [ds]
      } else if (char === '\u0008' || char === '\u007f') {
        if (key.length > 0) {
          key = key.slice(0, -1);
          process.stdout.write('\b \b');
        }
      // 0x03 is Ctrl+C. In raw mode the default SIGINT handler is bypassed, so we [ds]
      // exit with the conventional 130 code (128 + SIGINT) to match shell expectations. [ds]
      } else if (char === '\u0003') {
        process.stdin.setRawMode(false);
        process.exit(130);
      } else {
        key += char;
        process.stdout.write('*');
      }
    };
    process.stdin.on('data', onData);
  });
}

// Normalizes legacy single-provider configs (shape: { provider, apiKey, model, [ds]
// baseUrl, autoPrune }) into the current multi-provider schema (shape: [ds]
// { activeProvider, providers: { <name>: {...} } }). This lets users with older [ds]
// config files keep their credentials without re-running the wizard. [ds]
function migrateConfig(oldConfig) {
  // Only migrate when the old shape is detected: a top-level `provider` string [ds]
  // exists AND the new `providers` map is absent. Guards against undefined/null [ds]
  // and against already-migrated configs. [ds]
  if (oldConfig && typeof oldConfig === 'object' && oldConfig.provider && !oldConfig.providers) {
    return {
      activeProvider: oldConfig.provider,
      providers: {
        [oldConfig.provider]: {
          apiKey: oldConfig.apiKey || '',
          model: oldConfig.model || '',
          baseUrl: oldConfig.baseUrl || null,
          autoPrune: oldConfig.autoPrune || false
        }
      }
    };
  }
  return oldConfig;
}

// Loads configuration for the CLI. Resolution order: (1) environment variables [ds]
// (non-interactive / CI-friendly, takes precedence), (2) existing config file at [ds]
// ~/.devsplainrc, (3) interactive wizard as a fallback. When `forceWizard` is [ds]
// true the wizard runs even if a valid file config exists. [ds]
async function getConfig(forceWizard = false) {
  // Env-var path short-circuits the file lookup and wizard entirely, allowing [ds]
  // headless invocation. Either DEVSPLAIN_API_KEY or DEVSPLAIN_PROVIDER is enough [ds]
  // to trigger this branch. [ds]
  if (process.env.DEVSPLAIN_API_KEY || process.env.DEVSPLAIN_PROVIDER) {
    const provider = process.env.DEVSPLAIN_PROVIDER || 'gemini';
    // Nested ternaries select a sensible default model per provider so that setting [ds]
    // only DEVSPLAIN_PROVIDER (without an explicit DEVSPLAIN_MODEL) yields a working [ds]
    // configuration out of the box. [ds]
    const model = process.env.DEVSPLAIN_MODEL || (
      provider === 'gemini' ? 'gemini-2.0-flash' : (
        provider === 'claude' ? 'claude-3-5-sonnet-20240620' : (
          provider === 'deepseek' ? 'deepseek-chat' : (
            provider === 'openai' ? 'gpt-4o' : 'llama-3.3-70b-versatile'
          )
        )
      )
    );
    // Similarly derive the default base URL. Gemini uses the SDK's built-in endpoint [ds]
    // (so baseUrl stays null), while OpenAI-compatible providers need an explicit [ds]
    // host. Groq is the else-branch default since it exposes an OpenAI-compatible API. [ds]
    const baseUrl = process.env.DEVSPLAIN_BASE_URL || (
      provider === 'gemini' ? null : (
        provider === 'claude' ? 'https://api.anthropic.com' : (
          provider === 'deepseek' ? 'https://api.deepseek.com' : (
            provider === 'openai' ? 'https://api.openai.com' : 'https://api.groq.com/openai'
          )
        )
      )
    );
    return {
      provider,
      apiKey: process.env.DEVSPLAIN_API_KEY || '',
      model,
      baseUrl
    };
  }

  let fileConfig = null;
  // Parse the on-disk config defensively: missing/malformed JSON should not crash [ds]
  // the CLI. Any error (read failure, JSON parse error) is swallowed and we fall [ds]
  // through to the wizard so the user can recreate the config. [ds]
  if (fs.existsSync(configPath)) {
    try {
      const rawData = fs.readFileSync(configPath, 'utf8');
      fileConfig = migrateConfig(JSON.parse(rawData));
    } catch (e) {
    }
  }

  // Enter the interactive wizard when no usable config exists OR when the caller [ds]
  // explicitly forces it. A config is considered usable only if activeProvider, [ds]
  // providers, and the entry for the active provider are all present. [ds]
  if (!fileConfig || !fileConfig.activeProvider || !fileConfig.providers || !fileConfig.providers[fileConfig.activeProvider] || forceWizard) {
    let rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    });
    let askQuestion = (query) => new Promise((resolve) => rl.question(query, resolve));

    let config = fileConfig || { activeProvider: '', providers: {} };
    let confirmed = false;

    // Outer loop keeps the user in the wizard on invalid input (instead of aborting) [ds]
    // until they complete a full configuration and confirm it. [ds]
    while (!confirmed) {
      const savedProviders = Object.keys(config.providers);
      let providerToConfig = null;
      let wantToUpdate = true;
      let isNewProvider = false;

      // If providers already exist (e.g. wizard invoked via forceWizard on an existing [ds]
      // config), display a numbered menu so the user can pick an existing one to update [ds]
      // or add a new one. [ds]
      if (savedProviders.length > 0) {
        console.log("\nSaved Providers:");
        savedProviders.forEach((p, i) => {
          const isActive = config.activeProvider === p ? ' (active)' : '';
          console.log(`${i + 1}. ${p}${isActive}`);
        });
        console.log(`\n${savedProviders.length + 1}. Add/Configure a different provider`);
        const c = await askQuestion(`Select (1-${savedProviders.length + 1}): `);
        const idx = parseInt(c) - 1;

        // Option index 0..len-1 maps to an existing provider; index === len is the [ds]
        // 'Add/Configure a different provider' sentinel. Anything else is invalid input. [ds]
        if (idx >= 0 && idx < savedProviders.length) {
          providerToConfig = savedProviders[idx];
          const update = await askQuestion(`Do you want to update the API key or model for ${providerToConfig}? (y/N): `);
          if (update.trim().toLowerCase() !== 'y' && update.trim().toLowerCase() !== 'yes') {
            wantToUpdate = false;
          }
        } else if (idx === savedProviders.length) {
          isNewProvider = true;
        } else {
          console.log("Invalid choice.");
          continue;
        }
      } else {
        isNewProvider = true;
      }

      let baseUrl = "";
      let model = "";
      let provider = "";
      let apiKey = '';
      let autoPrune = false;

      if (wantToUpdate) {
        // Provider-selection flow only runs when we actually want to modify something. [ds]
        // When updating an existing provider and the user declined the y/N prompt, we [ds]
        // skip straight to confirmation with the existing values intact. [ds]
        if (isNewProvider || !providerToConfig) {
          console.log("\nWhich AI Provider Do You want to use?");
          console.log("1. Groq (Free, Fast, Llama-3)");
          console.log("2. Gemini (Free Tier)");
          console.log("3. OpenAI (Paid)");
          console.log("4. Custom (Ollama, local, etc)");
          console.log("5. Claude (Anthropic)");
          console.log("6. DeepSeek (deepseek-chat, deepseek-reasoner)");

          const choice = await askQuestion("Select (1-6): ");

          // Preferred-provider menu. Most options pre-fill baseUrl and offer a default [ds]
          // model so users can just press Enter; 'Custom' falls through to the loop below [ds]
          // that forces non-empty model and baseUrl values. [ds]
          if (choice === '1') {
            provider = 'groq';
            baseUrl = 'https://api.groq.com/openai';
            console.log("\nGet your free Groq key here: https://console.groq.com/keys");
            // Empty input is treated as 'use the default'; trim() guards against stray [ds]
            // whitespace counting as a real value. [ds]
            const customModel = await askQuestion("Model name (press Enter for default 'llama-3.3-70b-versatile'): ");
            model = customModel.trim() || 'llama-3.3-70b-versatile';
          } else if (choice === '2') {
            provider = 'gemini';
            baseUrl = null;
            console.log("\nGet your free Gemini key here: https://aistudio.google.com/apikey");
            const customModel = await askQuestion("Model name (press Enter for default 'gemini-2.0-flash'): ");
            model = customModel.trim() || 'gemini-2.0-flash';
          } else if (choice === '3') {
            provider = 'openai';
            baseUrl = 'https://api.openai.com';
            console.log("\nGet your OpenAI key here: https://platform.openai.com/api-keys");
            const customModel = await askQuestion("Model name (press Enter for default 'gpt-4o'): ");
            model = customModel.trim() || 'gpt-4o';
          } else if (choice === '4') {
            provider = 'custom';
            // Loop because an empty model name would produce a broken request later; keep [ds]
            // re-prompting until the user supplies a non-empty value. [ds]
            while (true) {
              model = (await askQuestion("Model name (e.g., llama3): ")).trim();
              if (model) break;
              console.log("Model name cannot be empty.");
            }
            // Same rationale as the model loop: a custom provider cannot function without [ds]
            // a base URL, so we refuse to accept an empty answer. [ds]
            while (true) {
              baseUrl = (await askQuestion("Base URL (e.g., http://localhost:11434): ")).trim();
              if (baseUrl) break;
              console.log("Base URL cannot be empty.");
            }
          } else if (choice === '5') {
            provider = 'claude';
            baseUrl = 'https://api.anthropic.com';
            console.log("\nGet your Anthropic key here: https://console.anthropic.com/settings/keys");
            // Offer a default model so users unfamiliar with Anthropic's naming don't have to look up the identifier; an empty trimmed input falls back via short-circuit OR. [ds]
            const customModel = await askQuestion("Model name (press Enter for default 'claude-3-5-sonnet-20240620'): ");
            model = customModel.trim() || 'claude-3-5-sonnet-20240620';
          } else if (choice === '6') {
            provider = 'deepseek';
            baseUrl = 'https://api.deepseek.com';
            console.log("\nGet your DeepSeek key here: https://platform.deepseek.com/api_keys");
            // Same default-model fallback pattern as the Anthropic branch: empty Enter preserves the DeepSeek default, avoiding an undefined model string. [ds]
            const customModel = await askQuestion("Model name (press Enter for default 'deepseek-chat'): ");
            model = customModel.trim() || 'deepseek-chat';
          // Any unrecognized menu selection restarts the loop via `continue` rather than throwing, so the wizard remains re-entrant and never partially writes config. [ds]
          } else {
            // Invalid menu selection restarts the outer while-loop without persisting [ds]
            // anything, so partial state is discarded and the user gets a clean retry. [ds]
            console.log("Invalid choice. Please select 1, 2, 3, 4, 5, or 6.");
            continue;
          }
        // Edit-existing-provider branch: reuse the stored baseUrl/model as defaults so the user can simply hit Enter to keep prior values. The custom provider additionally re-prompts for baseUrl since users may self-host at a different address. [ds]
        } else {
          provider = providerToConfig;
          const old = config.providers[provider];
          baseUrl = old.baseUrl;
          let defaultModel = old.model;
          const customModel = await askQuestion(`Model name (press Enter for default '${defaultModel}'): `);
          model = customModel.trim() || defaultModel;

          // Only the 'custom' provider exposes its baseUrl for editing; hosted providers pin their endpoints to avoid users accidentally pointing Anthropic/DeepSeek credentials at attacker-controlled hosts. [ds]
          if (provider === 'custom') {
            const customBase = await askQuestion(`Base URL (press Enter for default '${baseUrl}'): `);
            baseUrl = customBase.trim() || baseUrl;
          }
        }

        // API key acquisition loop. It must re-prompt on empty input for hosted providers but must allow empty keys for local/custom endpoints (e.g. Ollama) which don't require authentication. [ds]
        while (true) {
          const promptMsg = provider === 'custom' 
            ? "Paste your API key (leave blank for local models): " 
            : "Paste your API key: ";

          // When stdin is a TTY we temporarily close the readline interface so raw-mode secret input (echo suppressed) can be read without readline echoing the typed characters back. After capturing the secret we re-create the readline interface and rebuild the askQuestion helper bound to the new rl instance. [ds]
          if (process.stdin.isTTY) {
            rl.close();
            apiKey = await askSecret(promptMsg);

            rl = readline.createInterface({
              input: process.stdin,
              output: process.stdout
            });
            askQuestion = (query) => new Promise((resolve) => rl.question(query, resolve));
          // Non-TTY (piped/CI) input cannot use raw mode; fall back to plain readline so the key still gets read but will be visible in the stream — acceptable for automated provisioning. [ds]
          } else {
            apiKey = await askQuestion(promptMsg);
          }

          apiKey = apiKey.trim();
          // Custom/local providers explicitly bypass the non-empty key requirement; hosted providers must supply a non-empty key or we loop and warn the user. [ds]
          if (provider === 'custom' || apiKey) {
            break;
          }
          console.log(`API key is required for provider '${provider}'.`);
        }

        // Tri-state confirmation for aggressive pruning. Accepting 'y'/'yes'/'n'/'no'/empty makes the prompt forgiving; anything else re-prompts to avoid silently misconfiguring destructive overwrite behavior. [ds]
        while (true) {
          const pruneAns = (await askQuestion("Do you want devsplain to aggressively prune (overwrite) existing human/AI comments? (y/n, default: n): ")).trim().toLowerCase();
          if (pruneAns === '' || pruneAns === 'n' || pruneAns === 'no') {
            autoPrune = false;
            break;
          } else if (pruneAns === 'y' || pruneAns === 'yes') {
            autoPrune = true;
            break;
          }
          console.log("Invalid choice. Please enter 'y' or 'n'.");
        }

        console.log("\n--- Configuration Summary ---");
        console.log(`Provider:     ${provider}`);
        console.log(`Model:        ${model}`);
        console.log(`Base URL:     ${baseUrl || 'N/A'}`);
        // Mask the API key in the summary while preserving the first 4 chars for user recognition. Math.max(0, ...) guards against keys shorter than 4 chars which would otherwise produce a negative repeat count and throw. [ds]
        console.log(`API Key:      ${apiKey ? apiKey.substring(0, 4) + '*'.repeat(Math.max(0, apiKey.length - 4)) : 'None'}`);
        console.log(`Auto-Prune:   ${autoPrune ? 'Yes' : 'No'}`);
        console.log("-----------------------------\n");

        // Final confirmation gate. Only on explicit 'y' (or bare Enter, defaulting to yes) do we commit the provider into config.providers and set it as active. Choosing 'n' breaks out without mutating config, effectively cancelling the wizard. `confirmed` signals the outer loop to exit. [ds]
        while (true) {
          const confirm = (await askQuestion("Does this look correct? (y/n, default: y): ")).trim().toLowerCase();
          if (confirm === '' || confirm === 'y' || confirm === 'yes') {
            config.activeProvider = provider;
            // Persist the collected settings under the provider key. Overwrites any prior entry for this provider, which is the intended behavior when re-running the setup wizard for an existing provider. [ds]
            config.providers[provider] = {
              apiKey,
              model,
              baseUrl,
              autoPrune
            };
            confirmed = true;
            break;
          } else if (confirm === 'n' || confirm === 'no') {
            break;
          }
          console.log("Invalid choice. Please enter 'y' or 'n'.");
        }
      // The user chose to merely switch the active provider without re-entering credentials; mark confirmed so the enclosing loop terminates and proceed to write. [ds]
      } else {
        config.activeProvider = providerToConfig;
        console.log(`\nSwitched active provider to ${config.activeProvider}.`);
        confirmed = true;
      }
    }

    rl.close();

    // Persist config with 2-space indentation for human readability. Writing synchronously ensures the process cannot exit before the file is flushed. [ds]
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
    // Harden file permissions to owner-only (0600) on POSIX systems because config stores API keys in plaintext. Windows lacks POSIX mode semantics, hence the platform guard, and chmod failures are swallowed since the config is already written. [ds]
    try {
      if (process.platform !== 'win32') {
        fs.chmodSync(configPath, 0o600);
      }
    } catch (chmodErr) {}

    // Return a flattened view of the active provider so callers don't have to remember whether they need config.activeProvider or config.providers[...]; the spread exposes apiKey/model/baseUrl/autoPrune at the top level. [ds]
    return {
      provider: config.activeProvider,
      ...config.providers[config.activeProvider]
    };
  } else {
    // Read-only path: no wizard needed. The `|| {}` defends against a stale activeProvider name that no longer exists in the providers map, ensuring the spread below never throws on undefined. [ds]
    const active = fileConfig.providers[fileConfig.activeProvider] || {};
    return {
      provider: fileConfig.activeProvider,
      ...active
    };
  }
}

module.exports = { getConfig };
