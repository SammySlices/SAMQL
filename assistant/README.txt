SamQL offline SQL assistant pack
================================

This folder is optional. SamQL runs without it. When present, the bottom-right
chat icon can turn English into DuckDB SQL or SparkSQL using a local model.

No internet and no registration are required at runtime.

Contents (after running the fetch script):
  runtime/
    llama-server.exe   (Windows)  OR  llama-server  (Linux/macOS)
    ... companion DLLs / .so libraries from the llama.cpp CPU release ...
  models/
    one or more Instruct Q4_K_M GGUFs, for example:
      Qwen3-4B-Instruct-2507-Q4_K_M.gguf             (~2.5 GB, default)
      qwen2.5-coder-7b-instruct-q4_k_m.gguf         (~4.7 GB)

Model options (Apache 2.0, Q4_K_M GGUF). Fetch only downloads the size you
pick (4b / 7b); other GGUFs already under models/ are kept. Runtime
is shared.
  4b    Qwen3-4B-Instruct-2507   (default)
        Qwen2.5-Coder has no 4B size. This is a real 4B Instruct GGUF
        (Qwen3-4B-Instruct-2507 Q4_K_M) from Hugging Face, not a 3B
        relabeled as 4B.
  7b    Qwen2.5-Coder-7B-Instruct

Runtime: llama.cpp llama-server (native binary + libs, not Python, not Ollama).

Download (on a machine that CAN reach GitHub + Hugging Face):

  Windows:
    .\Fetch-SamQL-Assistant.ps1
    .\Fetch-SamQL-Assistant.ps1 -Model 4b
    .\Fetch-SamQL-Assistant.ps1 -Model 7b
    .\Fetch-SamQL-Assistant.ps1 -SkipModel   # llama-server only (no GGUF)

  Any OS with Python 3.10+:
    python tools/fetch_assistant_pack.py
    python tools/fetch_assistant_pack.py --model 4b
    python tools/fetch_assistant_pack.py --model 7b
    python tools/fetch_assistant_pack.py --skip-model

  Re-download:
    python tools/fetch_assistant_pack.py --force --model 4b

  Without --model / -Model on a terminal, the fetch script prompts and
  defaults to 4b on Enter. Non-interactive runs (CI / build) default to 4b.
  Default AppWindow builds fetch with --skip-model when runtime is missing.

Or choose packaging during the SamQL build (build.ps1 / build.sh prompts):
  1) lean     -- SamQL only; no assistant/ staged
  2) runtime  -- stage llama-server + DLLs only (DEFAULT; no GGUF)
  3) post     -- stage full assistant/ with a GGUF (~+2.5 GB+ for 4B)
  4) embed    -- bake full assistant/ into the PyInstaller payload (~+2.5 GB+)

  .\build.ps1 -AssistantPack lean|runtime|post|embed
  ./build.sh --assistant-pack lean|runtime|post|embed

  Default AppWindow builds ship runtime without a model. Add a GGUF later:
    .\Fetch-SamQL-Assistant.ps1 -Model 4b|7b
    python tools/fetch_assistant_pack.py --model 4b|7b

  Packaged lean/runtime installs also include an empty Model/ folder next
  to _internal (sibling of assistant/). Drop a .gguf there. SamQL prefers
  assistant/models/ when present, then Model/. Repo-dev fetch still writes
  to assistant/models/.

Locked-down work PC workflow:
  1. Run the fetch script on a home/build PC (pick 4b / 7b as needed).
  2. Copy the whole assistant/ folder next to SamQL-AppWindow (or set
     SAMQL_ASSISTANT_DIR). If the install already has assistant/runtime/,
     drop the GGUF into Model/ or assistant/models/.

Sources used by the fetch script:
  * llama-server: https://github.com/ggml-org/llama.cpp/releases (CPU build)
  * models:
      https://huggingface.co/unsloth/Qwen3-4B-Instruct-2507-GGUF
        Qwen3-4B-Instruct-2507-Q4_K_M.gguf
        (Qwen2.5-Coder has no 4B; official Qwen/Qwen3-4B-Instruct-GGUF
         is not published as a public GGUF resolve URL. This is a
         community Q4_K_M of official Qwen3-4B-Instruct-2507 weights.)
      https://huggingface.co/Qwen/Qwen2.5-Coder-7B-Instruct-GGUF
        qwen2.5-coder-7b-instruct-q4_k_m.gguf

Optional env:
  SAMQL_ASSISTANT_DIR   absolute path to this pack
  SAMQL_LLAMA_URL       if llama-server is already running (http://127.0.0.1:PORT)

Behaviour:
  * Generates only while DuckDB is idle (queries preempt chat).
  * Prompts use loaded table/column schema only -- not raw nested JSON dumps.

Runtime networking (local pack vs API)
--------------------------------------
Local models mode is offline by design at chat time:
  * SamQL starts llama-server on 127.0.0.1 with a local .gguf only.
  * Launch flags include --offline and --no-webui; HF/model-url, --tools,
    --agent, and WebUI MCP proxy env vars are cleared for the child process.
  * Chat is plain POST /v1/chat/completions (no tool schemas, no URL fetch).
  * SAMQL_LLAMA_URL, if set, must be loopback (127.0.0.1 / localhost).

Fetching models (Fetch-SamQL-Assistant / tools/fetch_assistant_pack.py)
needs GitHub + Hugging Face once; that is separate from runtime chat.

API mode (Settings → SQL assistant → API)
-----------------------------------------
Instead of (or as an alternative to) the local pack, you can point SamQL at
any OpenAI-compatible chat endpoint. This path DOES use the network when
the base URL is remote (intentional):

  Base URL   e.g. https://api.openai.com  or  http://127.0.0.1:8080
  Model id   optional (provider-specific, e.g. gpt-4o-mini)
  API key    optional; stored with Windows DPAPI when available

SamQL calls:  POST {base}/v1/chat/completions

Use Test connection in Settings, then Save. Switch back to Local models to
use the pack / preferred GGUF again. Clear API removes the saved endpoint
and key. DuckDB-idle gating still applies in API mode.

There is no hard lock that disables API mode: air-gapped users should stay
on Local models (and not set a remote API base URL).
