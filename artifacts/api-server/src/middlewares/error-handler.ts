import type { ErrorRequestHandler, RequestHandler } from "express";
import { ZodError } from "zod";
import { logger } from "../lib/logger";

/**
 * Every route in this app validates with Zod and every client error surface in the
 * OpenAPI spec is `{ "error": string }`. Without these two handlers Express falls back
 * to its HTML error page, so a failed validation reaches the browser as a 500 with no
 * machine-readable body and the UI can only show a generic "something went wrong".
 */

export const notFoundHandler: RequestHandler = (req, res) => {
  res.status(404).json({ error: `Cannot ${req.method} ${req.path}` });
};

const isBodyParserError = (
  error: unknown,
): error is { status: number; message: string } =>
  typeof error === "object" &&
  error !== null &&
  "status" in error &&
  typeof (error as { status: unknown }).status === "number" &&
  (error as { status: number }).status >= 400 &&
  (error as { status: number }).status < 500;

const describeZodError = (error: ZodError): string =>
  error.issues
    .map((issue) => {
      const path = issue.path.join(".");
      return path ? `${path}: ${issue.message}` : issue.message;
    })
    .join("; ");

export const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  if (res.headersSent) {
    return;
  }

  if (err instanceof ZodError) {
    res.status(400).json({ error: describeZodError(err) });
    return;
  }

  // express.json() rejects malformed payloads with a 4xx-tagged SyntaxError.
  if (isBodyParserError(err)) {
    res.status(err.status).json({ error: err.message });
    return;
  }

  logger.error({ err, method: req.method, path: req.path }, "Unhandled route error");
  res.status(500).json({ error: "Internal server error" });
};
