SamQL offline SQL assistant pack
================================

This folder is optional. SamQL runs without it. When present, the bottom-right
chat icon can turn English into DuckDB SQL or SparkSQL using a local model.

No internet and no registration are required at runtime.

Contents (prepare on a machine that CAN download, then copy here):
  llama-server.exe          (Windows)  OR  llama-server  (Linux/macOS)
  models/
    qwen2.5-coder-1.5b-instruct-q4_k_m.gguf

Model: Qwen2.5-Coder-1.5B-Instruct (Apache 2.0), Q4_K_M GGUF (~1 GB).
Runtime: llama.cpp llama-server (native binary, not Python, not Ollama).

Locked-down work PC workflow:
  1. On a home/build PC, download llama-server and the GGUF.
  2. Place them in this assistant/ layout.
  3. Copy the whole assistant/ folder next to SamQL (or set SAMQL_ASSISTANT_DIR).

Optional env:
  SAMQL_ASSISTANT_DIR   absolute path to this pack
  SAMQL_LLAMA_URL       if llama-server is already running (http://127.0.0.1:PORT)

Behaviour:
  * Generates only while DuckDB is idle (queries preempt chat).
  * Prompts use loaded table/column schema only — not raw nested JSON dumps.
