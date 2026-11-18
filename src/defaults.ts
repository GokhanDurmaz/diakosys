/** MiMo model served through the M5 llama.cpp server (defaults; all overridable via env). */
export const DEFAULT_PROVIDER = "mimo-llama-m5";
export const DEFAULT_MODEL_ID = "mimo-2.6-9b-q6";

/** Hostname the headless OpenCode server binds to and connects through. */
export const DEFAULT_HOSTNAME = "localhost";

/** Port the model server is expected on (llama.cpp default). */
export const DEFAULT_MODEL_PORT = 8082;

/** Documented safe default endpoint — localhost only, never an IP literal. */
export const DEFAULT_ENDPOINT = `http://${DEFAULT_HOSTNAME}:${DEFAULT_MODEL_PORT}/v1`;

/** Default project directory (the working directory). */
export const DEFAULT_PROJECT_DIR = process.cwd();

/** Default model server port. */
export const DEFAULT_PORT = 4096;

/** Default OpenCode server startup timeout (ms). */
export const DEFAULT_STARTUP_TIMEOUT_MS = 20_000;

/** Default max validated proposals per discovery area. */
export const DEFAULT_DISCOVERY_MAX_PROPOSALS = 3;

/** Default max discovery areas per run. */
export const DEFAULT_DISCOVERY_MAX_AREAS = 8;
