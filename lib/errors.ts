/**
 * Turns raw Postgres / PostgREST errors into something an admin can act on.
 *
 * The admin RPCs are thin SECURITY DEFINER wrappers around plain INSERT and
 * DELETE statements, so a constraint violation propagates to the browser
 * verbatim — e.g.
 *
 *   duplicate key value violates unique constraint "assets_name_unique"
 *
 * That is accurate but it reads like a crash, and it does not tell the person
 * what to do next. Map the cases we deliberately created constraints for to
 * plain English, and pass anything unrecognised through unchanged rather than
 * swallowing detail we might need while debugging.
 */

export type SupabaseLikeError = {
  message: string;
  code?: string;
  details?: string | null;
  hint?: string | null;
};

/** Constraint name -> what the admin should understand and do. */
const CONSTRAINT_MESSAGES: Record<string, string> = {
  assets_name_unique:
    "An asset with that tag already exists. Asset tags are unique across the fleet. If you are re-deploying this unit, edit the existing asset instead of creating a second one.",
};

/** Postgres SQLSTATE codes we can explain better than Postgres does. */
const SQLSTATE_MESSAGES: Record<string, string> = {
  "23503":
    "That record is still referenced by something else, or points at something that no longer exists.",
  "23514": "One of the values is outside the range this field allows.",
  "22P02": "One of the values is not in the format this field expects.",
  "23502": "A required field was left empty.",
};

function constraintNameFrom(message: string): string | null {
  const match = message.match(/constraint "([^"]+)"/);
  return match ? match[1] : null;
}

/** Pull the offending value out of a Postgres details string. */
function duplicateValueFrom(details?: string | null): string | null {
  if (!details) return null;
  const match = details.match(/\(([^)]*)\)=\(([^)]*)\)/);
  return match ? match[2] : null;
}

/**
 * Convert an error into a message worth showing. Returns the original message
 * when we have nothing better to say, so nothing is ever silently hidden.
 */
export function friendlyErrorMessage(error: SupabaseLikeError): string {
  const { message, code, details } = error;

  // A rejected PIN is by far the most common admin error and the raw text
  // ("not authorized") gives no hint that the PIN is what failed.
  if (/not authorized/i.test(message)) {
    return "Your admin username or PIN was not accepted. Check both and try again.";
  }

  if (code === "23505" || /duplicate key value/i.test(message)) {
    const constraint = constraintNameFrom(message);
    if (constraint && CONSTRAINT_MESSAGES[constraint]) {
      return CONSTRAINT_MESSAGES[constraint];
    }
    const value = duplicateValueFrom(details);
    return value
      ? `"${value}" already exists and has to be unique.`
      : "That value already exists and has to be unique.";
  }

  if (code && SQLSTATE_MESSAGES[code]) {
    return SQLSTATE_MESSAGES[code];
  }

  return message;
}

/** Prefix an action with its explained failure, e.g. "Could not add site: ..." */
export function actionError(action: string, error: SupabaseLikeError): string {
  return `${action}: ${friendlyErrorMessage(error)}`;
}
