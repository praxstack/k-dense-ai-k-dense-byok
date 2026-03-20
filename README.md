# K-Dense BYOK

**Your own AI research assistant, running on your computer, powered by your API keys.**

K-Dense BYOK (Bring Your Own Keys) is an open-source app that lets you chat with an AI assistant called **Kady**. You ask Kady a question or give it a task, and it figures out the best way to handle it — sometimes answering directly, sometimes spinning up specialized AI "experts" that work behind the scenes to get you a thorough result.

It's built for scientists, analysts, and curious people who want a powerful AI workspace without being locked into a single provider. K-Dense BYOK is powered by our very popular Claude Scientific Skills.

## What can it do?

- **Answer questions and complete tasks** — Ask Kady anything. For complex work, it delegates to AI experts that each have their own specialties (bioinformatics, finance, data analysis, etc.) with full access to 170+ scientific skills.
- **Search the web** — Kady can look things up online and pull in live information while working on your request.
- **Work with your files** — Upload files, create new ones, and preview them right in the app. Everything stays in a local sandbox folder on your machine.
- **Access 250+ scientific databases and 500k+ Python packages** — Kady's experts come pre-loaded with specialized scientific skills from [K-Dense](https://github.com/K-Dense-AI), covering everything from genomics to materials science.
- **Choose your AI model** — Pick from 40+ models (OpenAI, Anthropic, Google, xAI, Qwen, and more) through a simple dropdown in the app. You're not stuck with one.
- **Run heavy computations remotely** — Optionally connect [Modal](https://modal.com/) to run demanding workloads on powerful cloud hardware instead of your laptop.

## What you'll need before starting

| What | Why | Where to get it |
|------|-----|-----------------|
| A computer running **macOS or Linux** | The app runs locally on your machine | Windows works too — just use [WSL](https://learn.microsoft.com/en-us/windows/wsl/install) |
| An **OpenRouter API key** | This is how the AI models are accessed | [openrouter.ai](https://openrouter.ai/) — sign up and create a key |
| A **Parallel API key** *(optional)* | Lets Kady search the web | [parallel.ai](https://parallel.ai/) |
| **Modal** credentials *(optional)* | Only needed if you want remote compute for heavy jobs | [modal.com](https://modal.com/) |

That's it. The startup script handles installing everything else automatically.

## Getting started

### Step 1 — Download the project

Open a terminal and run:

```bash
git clone https://github.com/K-Dense-AI/k-dense-byok.git
cd k-dense-byok
```

### Step 2 — Add your API key

Create a file called `.env` inside the `kady_agent` folder with this content:

```env
# Your OpenRouter API key (required)
OPENROUTER_API_KEY=paste-your-key-here

# Enables web search (optional)
PARALLEL_API_KEY=paste-your-key-here

# Leave these as-is — they connect internal services
GOOGLE_GEMINI_BASE_URL=http://localhost:4000
GEMINI_API_KEY=sk-litellm-local

# The default AI model Kady uses (you can change this in the app later)
DEFAULT_AGENT_MODEL=openrouter/google/gemini-3.1-pro-preview

# Remote compute — only fill in if you have a Modal account (optional)
MODAL_TOKEN_ID=
MODAL_TOKEN_SECRET=
```

At minimum, you need to fill in `OPENROUTER_API_KEY`. Everything else is optional or should be left as-is.

### Step 3 — Start the app

```bash
chmod +x start.sh
./start.sh
```

The first time you run this, it will automatically install any missing tools (Python packages, Node.js, Gemini CLI) and download scientific skills. This may take a few minutes. After that, future starts will be much faster.

Once everything is running, your browser will open to **[http://localhost:3000](http://localhost:3000)** — that's the app.

To stop everything, press **Ctrl+C** in the terminal.

## How it works (the short version)

The app runs three services on your computer:

| Service | What it does |
|---------|-------------|
| **Frontend** (port 3000) | The web interface you interact with — chat, file browser, and file preview side by side |
| **Backend** (port 8000) | The brain — runs Kady and coordinates expert tasks |
| **LiteLLM proxy** (port 4000) | A translator that routes your AI requests to whichever model you've chosen via OpenRouter |

When you send a message, Kady reads it, decides whether to answer directly or delegate to an expert, uses any needed tools (web search, file operations, scientific databases), and streams the response back to you.

## Project layout

```
k-dense-byok/
├── start.sh              ← The one script that starts everything
├── server.py             ← Backend server
├── kady_agent/           ← Kady's brain: instructions, tools, and config
│   ├── .env              ← Your API keys go here
│   ├── agent.py          ← Main agent definition
│   └── tools/            ← Tools Kady can use (web search, delegation, etc.)
├── web/                  ← Frontend (the UI you see in your browser)
└── sandbox/              ← Workspace for files and expert tasks (created on first run)
```

## Why "BYOK"?

BYOK stands for **Bring Your Own Keys**. Instead of paying a subscription to a single AI company, you plug in API keys from whatever providers you prefer. You stay in control of which models you use, how much you spend, and where your data goes.

## Want more?

K-Dense BYOK is great for getting started, but if you want end-to-end research workflows with managed infrastructure, team collaboration, and no setup required, check out **[K-Dense Web](https://www.k-dense.ai)** — our full platform built for professional and academic research teams.

## Issues, bugs, or feature requests

If you run into a problem or have an idea for something new, please [open a GitHub issue](https://github.com/K-Dense-AI/k-dense-byok/issues). We read every one.

## About K-Dense

K-Dense BYOK is open source because [K-Dense](https://github.com/K-Dense-AI) believes in giving back to the community that makes this kind of work possible.

## Star History

<a href="https://www.star-history.com/?repos=K-Dense-AI%2Fk-dense-byok&type=date&legend=top-left">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/image?repos=K-Dense-AI/k-dense-byok&type=date&theme=dark&legend=top-left" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/image?repos=K-Dense-AI/k-dense-byok&type=date&legend=top-left" />
   <img alt="Star History Chart" src="https://api.star-history.com/image?repos=K-Dense-AI/k-dense-byok&type=date&legend=top-left" />
 </picture>
</a>
