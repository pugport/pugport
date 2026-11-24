# Hindsight memory pilot

Hindsight is an optional local memory service. It is **off by default**. This pilot supports retain and recall for selected projects. It does not bulk import existing history, call Reflect, enable automatic consolidation, or automatically download embedding models. PugPort's existing local memory remains available when the service cannot start or recall times out.

The integration has synthetic tests. An isolated Windows run with the actual pinned service and database passed authenticated startup, retention through the real PugPort bridge with a synthetic model response, recall, bank deletion and shutdown. Startup took 70.9 seconds. An isolated macOS run also passed the [Apple Silicon validation](#apple-silicon-validation). Both runs used synthetic data and zero paid API calls. Real-model quality and the full desktop workflow remain unverified.

An earlier Windows attempt stopped under host memory pressure. The pilot requires at least 2.5 GiB of available system memory before launch and checks memory once per second while its process runs. Below 1 GiB, it stops its own service and uses local memory; it does not restart automatically. This is a conservative protection, not a measured minimum requirement or a guarantee against brief memory spikes.

The service explicitly supplies its authentication extension to the engine. Startup checks missing, wrong and valid credentials before reporting ready. The convenience upstream server does not forward the environment's tenant extension, so it is not used. Run the lightweight wrapper regression checks with the configured Python: `python -I tests/hindsight-service.test.py`. They use only the Python standard library and run separately from the default Node test suite.

## Prepare the environment

Use a separate Python 3.11+ environment with [`hindsight-all==1.1.0`](https://pypi.org/project/hindsight-all/1.1.0/) and `pg0-embedded==0.15.2`. PugPort checks that `hindsight-all`, `hindsight-api-slim` and `hindsight-embed` are all version 1.1.0, and pg0 is version 0.15.2. The [upstream installation guide](https://hindsight.vectorize.io/developer/installation) documents native Windows x86-64 support with pg0; [pg0's README](https://github.com/vectorize-io/pg0/blob/main/README.md) lists Windows 10/11 support. This is upstream support, not a completed PugPort compatibility test.

Example manual preparation on Windows PowerShell. Replace the first path with a standalone Python 3.11+ installation; Windows Store Python can redirect virtual-environment paths:

```powershell
$hindsightPython = 'C:\replace-with-Python-installation\python.exe'
& $hindsightPython -m venv "$env:LOCALAPPDATA\PugPort-Hindsight\.venv"
& "$env:LOCALAPPDATA\PugPort-Hindsight\.venv\Scripts\python.exe" -m pip install "hindsight-all==1.1.0" "pg0-embedded==0.15.2"
```

The service uses CPU embeddings from the [English-focused `BAAI/bge-small-en-v1.5` model](https://huggingface.co/BAAI/bge-small-en-v1.5), with remote code and runtime model downloads disabled. Chinese-task recall and real retention quality have not been benchmarked; this pilot does not establish a quality improvement over existing retrieval. If you choose to download this model, prepare its cache explicitly before enabling the service. Find PugPort's **Data folder** in Settings, replace the example below with that exact folder, and run:

```powershell
$hindsightDataDir = 'C:\replace-with-PugPort-data-folder'
$env:PUGPORT_HINDSIGHT_CACHE = Join-Path $hindsightDataDir 'hindsight\models\huggingface\hub'
@'
import os
from pathlib import Path
os.environ['HF_HUB_DISABLE_XET'] = '1'
from huggingface_hub import snapshot_download
cache = str(Path(os.environ['PUGPORT_HINDSIGHT_CACHE']).resolve())
if not cache.startswith('\\\\?\\'):
    cache = '\\\\?\\UNC\\' + cache[2:] if cache.startswith('\\\\') else '\\\\?\\' + cache
revision = '5c38ec7c405ec4b44b94cc5a9bb96e735b38267a'
snapshot_download('BAAI/bge-small-en-v1.5', revision=revision, cache_dir=cache, token=False,
                  allow_patterns=['*.json', '*.safetensors', '*.txt', '1_Pooling/*'],
                  ignore_patterns=['onnx/*', 'openvino/*'])
refs = Path(cache) / 'models--BAAI--bge-small-en-v1.5' / 'refs'
refs.mkdir(parents=True, exist_ok=True)
(refs / 'main').write_text(revision, encoding='utf-8')
'@ | & "$env:LOCALAPPDATA\PugPort-Hindsight\.venv\Scripts\python.exe" -
```

These commands download packages and the selected CPU model files at the tested revision, then map the local offline `main` cache reference to that snapshot. The cache preparation and service use Windows extended-length paths so deep model-cache folders work without changing operating-system settings. They refer to the same data directory and preserve its permissions. PugPort does not run these download commands automatically. On another supported platform, use the corresponding virtual environment's absolute Python path and omit the Windows cache-path prefix. Missing packages or model files leave the service unavailable.

## Enable a small trial

1. In **Executors**, configure a managed API account and a positive per-run budget. Its existing budget, expiry, account eligibility and routing restrictions still apply. A total USD cap is optional; the per-run reserve is required.
2. Open **Settings → Personalization → Hindsight project memory (pilot)**.
3. Enter the environment's absolute Python executable path, select that API account, and select projects. Projects are stored by stable ID, not folder or display name.
4. Set the daily model call limit (1–100; default 20) and recall timeout (200–3000 milliseconds; default 1200). The daily counter uses UTC days, persists across restarts, and counts reserved attempts, including failed calls.
5. Select **Save config**, then enable the switch. **Refresh service status** reads status; it does not send a model test request. Initial service startup can take up to three minutes in the background. Chat does not wait for startup.

Only newly completed eligible tasks are queued. Each item contains the user's request and final reply, with source message IDs. Retention starts while PugPort is idle and uses the selected API through PugPort's normal usage ledger. It can incur API charges; the call cap is separate from the account's monetary budget. No API key is entered into this panel, and the child service does not inherit ambient provider credentials.

Recall adds only exact excerpts resolved back to existing local messages. It checks project identity, source content hashes and current memory eligibility after the service responds. Hindsight-generated text is not used as authoritative evidence or instructions. Original chats, handwritten project memory and the normal local retrieval path remain the source of record.

## Storage and removal

`dataDir` below is PugPort's configured Data folder (`controller.dataDir`):

| Location | Contents |
| --- | --- |
| `dataDir/hindsight/home/` | Private service home. On non-Windows platforms, pg0 lives in `.pg0/instances/<instance>/` beneath this folder. |
| `<Windows user home>/.pg0/instances/<instance>/` | Native Windows pg0 database. Windows resolves the OS user home independently of the service's private home. |
| `dataDir/hindsight/database.json` and `database-instance` | Private random local database credentials and instance marker. `<instance>` is `pugport-` followed by 32 random hexadecimal characters. |
| `dataDir/hindsight/models/huggingface/hub/` | Explicitly prepared embedding-model cache. |
| `dataDir/hindsight/model-calls.sqlite` | Persistent model-call reservations and run references; SQLite may also create `-wal` and `-shm` files. |
| `dataDir/studio.sqlite` | Existing PugPort store, including Hindsight source mappings, project generations and audit records. |

Keep the database credentials, instance marker and corresponding database together when backing up or restoring. Missing credentials for existing data cause startup to fail; do not delete them independently to reset the service. On Windows, backing up only the Data folder does not include the database. Cloud sync and backups follow each location's policy. Extracted memory text is sent to the selected API account for retention, even though the database and embeddings are local.

Hindsight's raw LLM-request tracing is disabled, so clearing a bank does not leave a second copy of its source text in Hindsight's debug call records. PugPort's normal run history and audit records remain subject to their existing retention behavior.

PugPort applies private permissions to the database directory and credentials (the current user and SYSTEM on Windows), and passes the database connection to Python through stdin. The upstream pg0 SDK currently passes its random **local database password** in a transient subprocess argument. This does not expose the selected provider's API key, but it is not protection against all local process inspection.

To forget a project's existing Hindsight copy, choose it under **Clear project Hindsight copy** and select **Clear this project's Hindsight copy**. Local source references are revoked first. PugPort then attempts service deletion and distinguishes confirmed deletion from an unconfirmed result. A pending extraction may need to settle before cleanup can finish. Revoked old copies are not reused. Original chats are not deleted.

Forgetting does not opt the project out of future retention. Uncheck that project and save, or turn the service off, to stop new Hindsight use. Turning it off does not delete stored copies.

## If it is unavailable

Check the absolute Python path, pinned package versions, prepared embedding cache, selected API budget and project selection. After correcting setup, turn the service off and on to restart it. A missing service, expired budget, exhausted call cap or recall timeout keeps local memory available. Audit events distinguish fallback from completed retention; an unavailable status is not proof that installation or inference succeeded.

## Apple Silicon validation

The isolated run used macOS 26.6.2 on an arm64 M4 Max, Node.js 24.22.1, Python 3.12.16, Hindsight 1.1.0 and pg0-embedded 0.15.2. It used the pinned BGE model from the [environment setup](#prepare-the-environment) to compute embeddings locally. The PugPort bridge received one deterministic response from a synthetic model controller.

- **Startup.** The service accepted authenticated requests and rejected requests without a token.
- **Retain and recall.** A completed synthetic task was retained through the bridge. Recall returned an excerpt tied to the original local message ID.
- **Delete.** Clearing the project's copy removed its bank from the service while preserving the original local message.
- **Shutdown and fallback.** After stopping the runtime, the service endpoint closed, PostgreSQL removed its PID file and the Python process group exited. A subsequent recall kept the local memory result and recorded the service as unavailable.

To repeat the check, use a temporary state directory and an isolated project with a synthetic completed task. Start the real Hindsight runtime with the prepared Python and model cache. Use the [model bridge test](../tests/hindsight-model-bridge.test.ts) controller fixture as a starting point for a deterministic extractor. Check the authenticated bank list after retention and deletion, and compare the recalled source ID with the local reply. Stop the runtime before checking fallback and process cleanup.
