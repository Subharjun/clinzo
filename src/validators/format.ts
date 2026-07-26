import type { ZodError, ZodIssue } from 'zod';

/**
 * Render Zod issues into a stable, client-consumable shape.
 *
 * Clients need to attach messages to specific form fields, so the path is
 * emitted as a dotted string and the issue `code` is preserved verbatim —
 * message text may be reworded, codes are contract.
 */

export interface FieldIssue {
  /** Dotted path, e.g. `slots.0.startsAt`. Empty string for root-level issues. */
  field: string;
  message: string;
  code: string;
}

export function formatZodIssues(error: ZodError): FieldIssue[] {
  return error.issues.map(toFieldIssue);
}

function toFieldIssue(issue: ZodIssue): FieldIssue {
  return {
    // Strip the `body`/`query`/`params` container segment the validate
    // middleware introduces, so clients see the path they actually sent.
    field: issue.path.slice(1).join('.') || issue.path.join('.'),
    message: issue.message,
    code: issue.code,
  };
}
