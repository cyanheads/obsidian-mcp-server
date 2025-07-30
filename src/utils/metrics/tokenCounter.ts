/**
 * @fileoverview Provides utility functions for counting tokens in text and chat messages
 * using the `tiktoken` library, specifically configured for 'gpt-4o' tokenization.
 * These functions are essential for managing token limits and estimating costs
 * when interacting with language models.
 * @module src/utils/metrics/tokenCounter
 */
import { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import { encoding_for_model, Tiktoken, TiktokenModel } from "tiktoken";
import { BaseErrorCode } from "../../types-global/errors.js";
import { ErrorHandler, logger, RequestContext } from "../index.js";

/**
 * The specific Tiktoken model used for all tokenization operations in this module.
 * This ensures consistent token counting.
 * @private
 */
const TOKENIZATION_MODEL: TiktokenModel = "gpt-4o";

/**
 * Calculates the number of tokens for a given text string using the
 * tokenizer specified by `TOKENIZATION_MODEL`.
 * Wraps tokenization in `ErrorHandler.tryCatch` for robust error management.
 *
 * @param text - The input text to tokenize.
 * @param context - Optional request context for logging and error handling.
 * @returns A promise that resolves with the number of tokens in the text.
 * @throws {McpError} If tokenization fails.
 */
export async function countTokens(
  text: string,
  context?: RequestContext,
): Promise<number> {
  return ErrorHandler.tryCatch(
    () => {
      let encoding: Tiktoken | null = null;
      try {
        encoding = encoding_for_model(TOKENIZATION_MODEL);
        const tokens = encoding.encode(text);
        return tokens.length;
      } finally {
        encoding?.free();
      }
    },
    {
      operation: "countTokens",
      context: context,
      input: { textSample: text.substring(0, 50) + "..." },
      errorCode: BaseErrorCode.INTERNAL_ERROR,
    },
  );
}

/**
 * Calculates the estimated number of tokens for an array of chat messages.
 * Uses the tokenizer specified by `TOKENIZATION_MODEL` and accounts for
 * special tokens and message overhead according to OpenAI's guidelines.
 *
 * For multi-part content, only text parts are currently tokenized.
 *
 * Reference: {@link https://github.com/openai/openai-cookbook/blob/main/examples/How_to_count_tokens_with_tiktoken.ipynb}
 *
 * @param messages - An array of chat messages.
 * @param context - Optional request context for logging and error handling.
 * @returns A promise that resolves with the estimated total number of tokens.
 * @throws {McpError} If tokenization fails.
 */
export async function countChatTokens(
  messages: ReadonlyArray<ChatCompletionMessageParam>,
  context?: RequestContext,
): Promise<number> {
  return ErrorHandler.tryCatch(
    () => {
      let encoding: Tiktoken | null = null;
      let num_tokens = 0;
      try {
        encoding = encoding_for_model(TOKENIZATION_MODEL);

        const tokens_per_message = 3; // For gpt-4o, gpt-4, gpt-3.5-turbo
        const tokens_per_name = 1; // For gpt-4o, gpt-4, gpt-3.5-turbo

        for (const message of messages) {
          num_tokens += tokens_per_message;
          num_tokens += encoding.encode(message.role).length;

          if (typeof message.content === "string") {
            num_tokens += encoding.encode(message.content).length;
          } else if (Array.isArray(message.content)) {
            for (const part of message.content) {
              if (part.type === "text") {
                num_tokens += encoding.encode(part.text).length;
              } else {
                logger.warning(
                  `Non-text content part found (type: ${part.type}), token count contribution ignored.`,
                  context,
                );
              }
            }
          }

          if ("name" in message && message.name) {
            num_tokens += tokens_per_name;
            num_tokens += encoding.encode(message.name).length;
          }

          if (
            message.role === "assistant" &&
            "tool_calls" in message &&
            message.tool_calls
          ) {
            for (const tool_call of message.tool_calls) {
              if (tool_call.function.name) {
                num_tokens += encoding.encode(tool_call.function.name).length;
              }
              if (tool_call.function.arguments) {
                num_tokens += encoding.encode(
                  tool_call.function.arguments,
                ).length;
              }
            }
          }

          if (
            message.role === "tool" &&
            "tool_call_id" in message &&
            message.tool_call_id
          ) {
            num_tokens += encoding.encode(message.tool_call_id).length;
          }
        }
        num_tokens += 3; // Every reply is primed with <|start|>assistant<|message|>
        return num_tokens;
      } finally {
        encoding?.free();
      }
    },
    {
      operation: "countChatTokens",
      context: context,
      input: { messageCount: messages.length },
      errorCode: BaseErrorCode.INTERNAL_ERROR,
    },
  );
}
