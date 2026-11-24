// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import type { ServiceHandler } from "@aws-smithy/server-common";
import type { HttpRequest, HttpResponse } from "@smithy/core/protocols";
import { convertEvent } from "@smithy/server-apigateway";
import type { APIGatewayProxyResult } from "aws-lambda";

import { BaseApiLambdaEnvironment } from "@amzn/innovation-sandbox-commons/lambda/environments/base-api-lambda-environment.js";
import { convertToIsbResponse } from "@amzn/innovation-sandbox-commons/lambda/smithy/convert-to-isb-response.js";
import { frameworkExceptionType } from "@amzn/innovation-sandbox-commons/lambda/smithy/framework-exception-response.js";
import { IsbSmithyContext } from "@amzn/innovation-sandbox-commons/lambda/smithy/isb-smithy-context.js";

/**
 * The API Lambda's handler function — what a domain hands to its Middy bundle's
 * `.handler(...)`. It receives the API Gateway event and the Middy Lambda context
 * (with `env`, `user` and `globalConfig`) that the bundle infers, and resolves to
 * the pre-Smithy `{ statusCode, headers, body }` result.
 *
 * This is a simplified, ISB-context-typed form of aws-lambda's `Handler` (which
 * `.handler(...)` ultimately expects): it drops the unused `callback` and narrows
 * the return to a `Promise`. There is no importable type to reuse — Middy's
 * context-substituting wrapper (`MiddlewareHandler`) is not exported, and
 * aws-lambda's `Handler` carries the base `Context`, not our `IsbApiContext`.
 */
export type ApiLambdaHandler<TEnv extends BaseApiLambdaEnvironment> = (
  event: IsbSmithyContext<TEnv>["event"],
  lambdaContext: IsbSmithyContext<TEnv>["lambdaContext"],
) => Promise<APIGatewayProxyResult>;

/**
 * Adapts a generated Smithy service handler into the API Lambda handler a domain
 * hands to its Middy bundle's `.handler(...)` — the standard
 * `convertEvent → handle → convertVersion*Response` shape. It is domain-agnostic:
 * any operation whose implementations use an `IsbSmithyContext` can reuse it as its
 * domain moves onto the generated bindings.
 *
 * The one ISB-specific difference from the stock internal pattern is that error
 * rendering is delegated back to the existing Middy `httpErrorHandler` rather than
 * to the generated pipeline (see `withDelegatedErrors` and
 * `IsbSmithyContext.delegatedError`), so the pre-Smithy response bytes are preserved.
 *
 * The returned handler, per request: converts the API Gateway event with
 * `convertEvent`, dispatches it through `handle()`, then
 *  - rethrows a delegated business error past the pipeline so `httpErrorHandler`
 *    produces the pre-Smithy response;
 *  - detects a pipeline `InternalFailure` (which `handle()` *returns* rather than
 *    throws) and rethrows the original captured error so `httpErrorHandler` logs its
 *    real message and stack and renders the pre-Smithy 500;
 *  - otherwise converts the response back to the pre-Smithy wire with
 *    `convertToIsbResponse`.
 *
 * The service handler's parameter type mirrors what a generated
 * `get<Domain>ApiServiceHandler` returns (`@smithy/core/protocols` request/response
 * types, overriding the server-common defaults).
 *
 * Call this once per service handler (at module load). It registers a
 * `readAfterExecution` interceptor on `serviceHandler` as a side effect; calling it
 * again on the same handler would register a duplicate interceptor — harmless (it
 * only re-assigns the same `pipelineError`), but avoid it.
 */
/**
 * Drops the `Content-Type` header from a request that has no body.
 */
export function stripContentTypeWhenBodyless<
  T extends { body?: string | null },
>(
  event: T & {
    headers?: Record<string, string | undefined> | null;
    multiValueHeaders?: Record<string, string[] | undefined> | null;
  },
): typeof event {
  if (event.body) {
    return event;
  }
  const withoutContentType = <V>(
    headers: Record<string, V | undefined> | null | undefined,
  ) =>
    headers === null || headers === undefined
      ? headers
      : Object.fromEntries(
          Object.entries(headers).filter(
            ([name]) => name.toLowerCase() !== "content-type",
          ),
        );

  return {
    ...event,
    headers: withoutContentType(event.headers),
    multiValueHeaders: withoutContentType(event.multiValueHeaders),
  };
}

export function toLambdaHandler<TEnv extends BaseApiLambdaEnvironment>(
  serviceHandler: ServiceHandler<
    IsbSmithyContext<TEnv>,
    HttpRequest,
    HttpResponse
  >,
): ApiLambdaHandler<TEnv> {
  // Capture the error the generated pipeline catches internally (deserialize,
  // validate, serialize) via the `readAfterExecution` hook, so a pipeline
  // `InternalFailure` can be rethrown with its original message and stack rather
  // than a generic replacement.
  serviceHandler.addInterceptor({
    readAfterExecution(hook) {
      hook.context.pipelineError = hook.error;
    },
  });

  const handler: ApiLambdaHandler<TEnv> = async (
    event: IsbSmithyContext<TEnv>["event"],
    lambdaContext: IsbSmithyContext<TEnv>["lambdaContext"],
  ): Promise<APIGatewayProxyResult> => {
    const context: IsbSmithyContext<TEnv> = { event, lambdaContext };

    const httpResponse: HttpResponse = await serviceHandler.handle(
      convertEvent(stripContentTypeWhenBodyless(event)),
      context,
    );

    if (context.delegatedError !== undefined) {
      // A business error whose rendering is delegated to `httpErrorHandler`.
      // Rethrow it past the generated pipeline so it gets handled by the pre-Smithy
      // `httpErrorHandler` in the Middy middleware chain, rather than re-implementing
      // JSend error rendering here.
      throw context.delegatedError;
    }

    if (frameworkExceptionType(httpResponse) === "InternalFailure") {
      // A failure inside the generated pipeline itself — e.g. response
      // serialization of a malformed stored item. The pipeline *returns* its
      // InternalFailureException rather than throwing it, so rethrow the original
      // error (captured above) so the pre-Smithy `httpErrorHandler` in the Middy
      // middleware chain logs its real message and stack and renders the 500,
      // matching every other unexpected server error.
      const original = context.pipelineError;
      if (original instanceof Error) {
        throw original;
      }
      const cause = original === undefined ? undefined : { cause: original };
      throw new Error(
        "Unexpected failure in the generated service pipeline.",
        cause,
      );
    }

    // Success, a modeled validation failure, or a framework exception: convert the
    // generated response to the pre-Smithy result shape (library
    // `convertVersion2Response` plus the ISB header shim).
    return convertToIsbResponse(httpResponse);
  };

  return handler;
}

/**
 * Wraps a Smithy operation so any error it throws is recorded on
 * `context.delegatedError` (and rethrown), delegating its rendering to the existing
 * Middy `httpErrorHandler` in `apiMiddlewareBundle` — the one code path that already
 * renders error responses for every other route (the pre-Smithy `createHttpJSendError`
 * → `httpErrorHandler` flow) — rather than re-implementing that rendering inside the
 * generated Smithy pipeline.
 *
 * It cannot be a plain try/catch in `toLambdaHandler`: the generated `handle()`
 * invokes the operation itself and, on a throw, *returns* a converted response
 * instead of rethrowing — so `toLambdaHandler` never sees the original error. Worse,
 * `createHttpJSendError` errors collide by name with modeled errors (a 404 is an
 * http-errors `NotFoundError`, which `GetLeaseTemplate` also declares), so the
 * pipeline would mis-serialize them as modeled errors (adding an `x-amzn-errortype`
 * the pre-Smithy response never had). Recording the error on the context and rethrowing
 * lets the Lambda handler rethrow it past the pipeline so `httpErrorHandler` produces
 * the pre-Smithy bytes.
 *
 * Every error an operation throws is a business error the model does not render;
 * model-constraint failures are rendered by the customizer before the operation
 * runs, so they never reach here. Generic over the context so every domain can use
 * it.
 */
export function withDelegatedErrors<
  Input,
  Output,
  Context extends { delegatedError?: unknown },
>(
  operation: (input: Input, context: Context) => Promise<Output>,
): (input: Input, context: Context) => Promise<Output> {
  return async (input, context) => {
    try {
      return await operation(input, context);
    } catch (error) {
      context.delegatedError = error;
      throw error;
    }
  };
}
