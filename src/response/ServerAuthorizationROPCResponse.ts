/*
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License.
 */

import { ServerAuthorizationTokenResponse } from "./ServerAuthorizationTokenResponse";

/**
 * Deserialized response object from server authorization code request in the ROPC flow.
 * - token_type: Indicates the token type value. The only type that Azure AD supports is Bearer.
 * - scope: The scopes that the access_token is valid for.
 * - expires_in: How long the access token is valid (in seconds).
 * - access_token: The requested access token. The app can use this token to authenticate to the secured resource, such as a web API.
 * - refresh_token: An OAuth 2.0 refresh token. The app can use this token acquire additional access tokens after the current access token expires.
 * - id_token: A JSON Web Token (JWT). The app can decode the segments of this token to request information about the user who signed in.
 */
export type ServerAuthorizationROPCResponse = Pick<ServerAuthorizationTokenResponse, "token_type" | "scope" | "expires_in" | "id_token"> & {
    access_token?: string,
    refresh_token?: string
};
