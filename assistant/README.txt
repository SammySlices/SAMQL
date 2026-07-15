SamQL offline SQL assistant pack
================================

This folder is optional. SamQL runs without it. When present, the bottom-right
chat icon can turn English into DuckDB SQL or SparkSQL using a local model.

No internet and no registration are required at runtime.

Contents (after running the fetch script):
  runtime/
    llama-server.exe   (Windows)  OR  llama-server  (Linux/macOS)
    … companion DLLs / .so libraries from the llama.cpp CPU release …
  models/
    qwen2.5-coder-1.5b-instruct-q4_k_m.gguf

Model: Qwen2.5-Coder-1.5B-Instruct (Apache 2.0), Q4_K_M GGUF (~1 GB).
Runtime: llama.cpp llama-server (native binary + libs, not Python, not Ollama).

Download (on a machine that CAN reach GitHub + Hugging Face):

  Windows:
    .\Fetch-SamQL-Assistant.ps1

  Any OS with Python 3.10+:
    python tools/fetch_assistant_pack.py

  Re-download:
    python tools/fetch_assistant_pack.py --force

Locked-down work PC workflow:
  1. Run the fetch script on a home/build PC.
  2. Copy the whole assistant/ folder next to SamQL (or set SAMQL_ASSISTANT_DIR).

Sources used by the fetch script:
  * llama-server: https://github.com/ggml-org/llama.cpp/releases (CPU build)
  * model: https://huggingface.co/Qwen/Qwen2.5-Coder-1.5B-Instruct-GGUF
    file qwen2.5-coder-1.5b-instruct-q4_k_m.gguf

Optional env:
  SAMQL_ASSISTANT_DIR   absolute path to this pack
  SAMQL_LLAMA_URL       if llama-server is already running (http://127.0.0.1:PORT)

Behaviour:
  * Generates only while DuckDB is idle (queries preempt chat).
  * Prompts use loaded table/column schema only — not raw nested JSON dumps.
