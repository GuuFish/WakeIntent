import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

import {
  Ajv2020,
  type ErrorObject,
  type ValidateFunction,
} from "ajv/dist/2020.js";
import type { FormatsPlugin } from "ajv-formats";

type SchemaName =
  | "contact-intent"
  | "contact-intent-activation"
  | "contact-intent-evaluation-failure"
  | "contact-intent-evaluation-request"
  | "contact-policy-signal"
  | "conversation-event"
  | "decision";

const ajv = new Ajv2020({ allErrors: true, strict: true });
const require = createRequire(import.meta.url);
const addFormats = require("ajv-formats") as FormatsPlugin;
addFormats(ajv);

function loadSchema(name: SchemaName): object {
  const url = new URL(`../schemas/${name}.schema.json`, import.meta.url);
  return JSON.parse(readFileSync(url, "utf8")) as object;
}

const validators = {
  contactIntent: ajv.compile(loadSchema("contact-intent")),
  contactIntentActivation: ajv.compile(loadSchema("contact-intent-activation")),
  contactIntentEvaluationFailure: ajv.compile(
    loadSchema("contact-intent-evaluation-failure"),
  ),
  contactIntentEvaluationRequest: ajv.compile(
    loadSchema("contact-intent-evaluation-request"),
  ),
  contactPolicySignal: ajv.compile(loadSchema("contact-policy-signal")),
  conversationEvent: ajv.compile(loadSchema("conversation-event")),
  decision: ajv.compile(loadSchema("decision")),
} satisfies Record<string, ValidateFunction>;

export type SchemaValidationResult =
  | { valid: true; errors: [] }
  | { valid: false; errors: ErrorObject[] };

function runValidator(
  validator: ValidateFunction,
  value: unknown,
): SchemaValidationResult {
  if (validator(value)) {
    return { valid: true, errors: [] };
  }

  return { valid: false, errors: validator.errors ? [...validator.errors] : [] };
}

export function validateContactIntent(value: unknown): SchemaValidationResult {
  return runValidator(validators.contactIntent, value);
}

export function validateContactIntentActivation(
  value: unknown,
): SchemaValidationResult {
  return runValidator(validators.contactIntentActivation, value);
}

export function validateContactIntentEvaluationFailure(
  value: unknown,
): SchemaValidationResult {
  return runValidator(validators.contactIntentEvaluationFailure, value);
}

export function validateContactIntentEvaluationRequest(
  value: unknown,
): SchemaValidationResult {
  return runValidator(validators.contactIntentEvaluationRequest, value);
}

export function validateContactPolicySignal(
  value: unknown,
): SchemaValidationResult {
  return runValidator(validators.contactPolicySignal, value);
}

export function validateConversationEvent(value: unknown): SchemaValidationResult {
  return runValidator(validators.conversationEvent, value);
}

export function validateDecision(value: unknown): SchemaValidationResult {
  return runValidator(validators.decision, value);
}
