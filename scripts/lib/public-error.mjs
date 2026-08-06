const PUBLIC_DIAGNOSTICS = Object.freeze({
  FC_ARG_DUPLICATE: "an option was provided more than once",
  FC_ARG_UNKNOWN: "the command line contains an unsupported option",
  FC_ARG_VALUE_MISSING: "an option value is missing",
  FC_KEY_MISSING: "WINDSURF_API_KEY is required",
  FC_OUTPUT_LIMIT: "the bounded output limit was exceeded",
  FC_PATH_DENIED: "the requested path is denied",
  FC_PATH_INVALID: "the requested path is invalid",
  FC_PATH_UNAVAILABLE: "the requested path is unavailable",
  FC_PROJECT_ALIAS: "the project option alias is unsupported",
  FC_PROJECT_DUPLICATE: "the project option must be provided exactly once",
  FC_PROJECT_INVALID: "the project must be an existing directory",
  FC_PROJECT_REQUIRED: "--project is required",
  FC_PROTOCOL_INVALID: "the remote response did not match the supported protocol",
  FC_QUERY_REQUIRED: "--query is required",
  FC_REMOTE_UNAVAILABLE: "the external search service is unavailable",
  FC_TOOL_UNAVAILABLE: "the local search tool failed safely",
});

export class FastContextError extends Error {
  /**
   * @param {keyof typeof PUBLIC_DIAGNOSTICS|string} code
   */
  constructor(code) {
    super(String(code));
    this.name = "FastContextError";
    this.code = String(code);
  }
}

export function publicDiagnostic(error) {
  const code = error?.code || "FC_REMOTE_UNAVAILABLE";
  return PUBLIC_DIAGNOSTICS[code] || "the operation failed safely";
}

export function isFastContextError(error) {
  return error instanceof FastContextError;
}

export { PUBLIC_DIAGNOSTICS };
