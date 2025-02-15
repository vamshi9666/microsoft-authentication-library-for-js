/*
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License.
 */

import { AuthenticationResult, Logger, ICrypto, PromptValue, AuthToken, Constants, AccountEntity, AuthorityType, ScopeSet, TimeUtils, AuthenticationScheme, UrlString, OIDC_DEFAULT_SCOPES, PopTokenGenerator, SignedHttpRequestParameters, IPerformanceClient, PerformanceEvents, ClientAuthError } from "@azure/msal-common";
import { BaseInteractionClient } from "./BaseInteractionClient";
import { BrowserConfiguration } from "../config/Configuration";
import { BrowserCacheManager } from "../cache/BrowserCacheManager";
import { EventHandler } from "../event/EventHandler";
import { PopupRequest } from "../request/PopupRequest";
import { SilentRequest } from "../request/SilentRequest";
import { SsoSilentRequest } from "../request/SsoSilentRequest";
import { NativeMessageHandler } from "../broker/nativeBroker/NativeMessageHandler";
import { NativeExtensionMethod, ApiId, TemporaryCacheKeys } from "../utils/BrowserConstants";
import { NativeExtensionRequestBody, NativeTokenRequest } from "../broker/nativeBroker/NativeRequest";
import { NativeResponse } from "../broker/nativeBroker/NativeResponse";
import { NativeAuthError } from "../error/NativeAuthError";
import { RedirectRequest } from "../request/RedirectRequest";
import { NavigationOptions } from "../navigation/NavigationOptions";
import { INavigationClient } from "../navigation/INavigationClient";
import { BrowserAuthError } from "../error/BrowserAuthError";

export class NativeInteractionClient extends BaseInteractionClient {
    protected apiId: ApiId;
    protected accountId: string;
    protected nativeMessageHandler: NativeMessageHandler;

    constructor(config: BrowserConfiguration, browserStorage: BrowserCacheManager, browserCrypto: ICrypto, logger: Logger, eventHandler: EventHandler, navigationClient: INavigationClient, apiId: ApiId, performanceClient: IPerformanceClient, provider: NativeMessageHandler, accountId: string, correlationId?: string) {
        super(config, browserStorage, browserCrypto, logger, eventHandler, navigationClient, performanceClient, provider, correlationId);
        this.apiId = apiId;
        this.accountId = accountId;
        this.nativeMessageHandler = provider;
    }

    /**
     * Acquire token from native platform via browser extension
     * @param request
     */
    async acquireToken(request: PopupRequest|SilentRequest|SsoSilentRequest): Promise<AuthenticationResult> {
        this.logger.trace("NativeInteractionClient - acquireToken called.");

        // start the perf measurement
        const nativeATMeasurement = this.performanceClient.startMeasurement(PerformanceEvents.NativeInteractionClientAcquireToken, request.correlationId);
        const nativeRequest = await this.initializeNativeRequest(request);

        const messageBody: NativeExtensionRequestBody = {
            method: NativeExtensionMethod.GetToken,
            request: nativeRequest
        };

        const reqTimestamp = TimeUtils.nowSeconds();
        const response: object = await this.nativeMessageHandler.sendMessage(messageBody);
        const validatedResponse: NativeResponse = this.validateNativeResponse(response);

        return this.handleNativeResponse(validatedResponse, nativeRequest, reqTimestamp)
            .then((result: AuthenticationResult) => {
                nativeATMeasurement.endMeasurement({
                    success: true,
                    isNativeBroker: true
                });
                return result;
            })
            .catch((error) => {
                nativeATMeasurement.endMeasurement({
                    success: false,
                    isNativeBroker: true
                });
                throw error;
            });
    }

    /**
     * Acquires a token from native platform then redirects to the redirectUri instead of returning the response
     * @param request
     */
    async acquireTokenRedirect(request: RedirectRequest): Promise<void> {
        this.logger.trace("NativeInteractionClient - acquireTokenRedirect called.");
        const nativeRequest = await this.initializeNativeRequest(request);

        const messageBody: NativeExtensionRequestBody = {
            method: NativeExtensionMethod.GetToken,
            request: nativeRequest
        };

        try {
            const response: object = await this.nativeMessageHandler.sendMessage(messageBody);
            this.validateNativeResponse(response);
        } catch (e) {
            // Only throw fatal errors here to allow application to fallback to regular redirect. Otherwise proceed and the error will be thrown in handleRedirectPromise
            if (e instanceof NativeAuthError && e.isFatal()) {
                throw e;
            }
        }
        this.browserStorage.setTemporaryCache(TemporaryCacheKeys.NATIVE_REQUEST, JSON.stringify(nativeRequest), true);

        const navigationOptions: NavigationOptions = {
            apiId: ApiId.acquireTokenRedirect,
            timeout: this.config.system.redirectNavigationTimeout,
            noHistory: false
        };
        const redirectUri = this.config.auth.navigateToLoginRequestUrl ? window.location.href : this.getRedirectUri(request.redirectUri);
        await this.navigationClient.navigateExternal(redirectUri, navigationOptions); // Need to treat this as external to ensure handleRedirectPromise is run again
    }

    /**
     * If the previous page called native platform for a token using redirect APIs, send the same request again and return the response
     */
    async handleRedirectPromise(): Promise<AuthenticationResult | null> {
        this.logger.trace("NativeInteractionClient - handleRedirectPromise called.");
        if (!this.browserStorage.isInteractionInProgress(true)) {
            this.logger.info("handleRedirectPromise called but there is no interaction in progress, returning null.");
            return null;
        }

        const cachedRequest = this.browserStorage.getCachedNativeRequest();
        if (!cachedRequest) {
            this.logger.verbose("NativeInteractionClient - handleRedirectPromise called but there is no cached request, returning null.");
            return null;
        }

        this.browserStorage.removeItem(this.browserStorage.generateCacheKey(TemporaryCacheKeys.NATIVE_REQUEST));

        const messageBody: NativeExtensionRequestBody = {
            method: NativeExtensionMethod.GetToken,
            request: cachedRequest
        };

        const reqTimestamp = TimeUtils.nowSeconds();

        try {
            this.logger.verbose("NativeInteractionClient - handleRedirectPromise sending message to native broker.");
            const response: object = await this.nativeMessageHandler.sendMessage(messageBody);
            this.validateNativeResponse(response);
            const result = this.handleNativeResponse(response as NativeResponse, cachedRequest, reqTimestamp);
            this.browserStorage.setInteractionInProgress(false);
            return result;
        } catch (e) {
            this.browserStorage.setInteractionInProgress(false);
            throw e;
        }
    }

    /**
     * Logout from native platform via browser extension
     * @param request
     */
    logout(): Promise<void> {
        this.logger.trace("NativeInteractionClient - logout called.");
        return Promise.reject("Logout not implemented yet");
    }

    /**
     * Transform response from native platform into AuthenticationResult object which will be returned to the end user
     * @param response
     * @param request
     * @param reqTimestamp
     */
    protected async handleNativeResponse(response: NativeResponse, request: NativeTokenRequest, reqTimestamp: number): Promise<AuthenticationResult> {
        this.logger.trace("NativeInteractionClient - handleNativeResponse called.");

        if (response.account.id !== request.accountId) {
            // User switch in native broker prompt is not supported. All users must first sign in through web flow to ensure server state is in sync
            throw NativeAuthError.createUserSwitchError();
        }

        // create an idToken object (not entity)
        const idTokenObj = new AuthToken(response.id_token || Constants.EMPTY_STRING, this.browserCrypto);

        // Get the preferred_cache domain for the given authority
        const authority = await this.getDiscoveredAuthority(request.authority);
        const authorityPreferredCache = authority.getPreferredCache();

        // Save account in browser storage
        const homeAccountIdentifier = AccountEntity.generateHomeAccountId(response.client_info || Constants.EMPTY_STRING, AuthorityType.Default, this.logger, this.browserCrypto, idTokenObj);
        const accountEntity = AccountEntity.createAccount(response.client_info, homeAccountIdentifier, idTokenObj, undefined, undefined, undefined, undefined, authorityPreferredCache, response.account.id);
        this.browserStorage.setAccount(accountEntity);

        // If scopes not returned in server response, use request scopes
        const responseScopes = response.scopes ? ScopeSet.fromString(response.scopes) : ScopeSet.fromString(request.scopes);

        const accountProperties = response.account.properties || {};
        const uid = accountProperties["UID"] || idTokenObj.claims.oid || idTokenObj.claims.sub || Constants.EMPTY_STRING;
        const tid = accountProperties["TenantId"] || idTokenObj.claims.tid || Constants.EMPTY_STRING;

        // This code prioritizes SHR returned from the native layer. In case of error/SHR not calculated from WAM and the AT is still received, SHR is calculated locally
        let responseAccessToken;
        let responseTokenType: AuthenticationScheme = AuthenticationScheme.BEARER;
        switch (request.token_type) {
            case AuthenticationScheme.POP: {
                // Set the token type to POP in the response
                responseTokenType = AuthenticationScheme.POP;

                // Check if native layer returned an SHR token
                if (response.shr) {
                    this.logger.trace("handleNativeServerResponse: SHR is enabled in native layer");
                    responseAccessToken = response.shr;
                    break;
                }

                // Generate SHR in msal js if WAM does not compute it when POP is enabled
                const popTokenGenerator: PopTokenGenerator = new PopTokenGenerator(this.browserCrypto);
                const shrParameters: SignedHttpRequestParameters = {
                    resourceRequestMethod: request.resourceRequestMethod,
                    resourceRequestUri: request.resourceRequestUri,
                    shrClaims: request.shrClaims,
                    shrNonce: request.shrNonce
                };

                /**
                 * KeyID must be present in the native request from when the PoP key was generated in order for
                 * PopTokenGenerator to query the full key for signing
                 */
                if (!request.keyId) {
                    throw ClientAuthError.createKeyIdMissingError();
                }

                responseAccessToken = await popTokenGenerator.signPopToken(response.access_token, request.keyId, shrParameters);
                break;

            }
            // assign the access token to the response for all non-POP cases (Should be Bearer only today)
            default: {
                responseAccessToken = response.access_token;
            }
        }

        const result: AuthenticationResult = {
            authority: authority.canonicalAuthority,
            uniqueId: uid,
            tenantId: tid,
            scopes: responseScopes.asArray(),
            account: accountEntity.getAccountInfo(),
            idToken: response.id_token,
            idTokenClaims: idTokenObj.claims,
            accessToken: responseAccessToken,
            fromCache: false,
            expiresOn: new Date(Number(reqTimestamp + response.expires_in) * 1000),
            tokenType: responseTokenType,
            correlationId: this.correlationId,
            state: response.state,
            fromNativeBroker: true
        };

        // Remove any existing cached tokens for this account
        this.browserStorage.removeAccountContext(accountEntity).catch((e) => {
            this.logger.error(`Error occurred while removing account context from browser storage. ${e}`);
        });

        return result;
    }

    /**
     * Validates native platform response before processing
     * @param response
     */
    private validateNativeResponse(response: object): NativeResponse {
        if (
            response.hasOwnProperty("access_token") &&
            response.hasOwnProperty("id_token") &&
            response.hasOwnProperty("client_info") &&
            response.hasOwnProperty("account") &&
            response.hasOwnProperty("scopes") &&
            response.hasOwnProperty("expires_in")
        ) {
            return response as NativeResponse;
        } else {
            throw NativeAuthError.createUnexpectedError("Response missing expected properties.");
        }
    }

    /**
     * Translates developer provided request object into NativeRequest object
     * @param request
     */
    protected async initializeNativeRequest(request: PopupRequest|SsoSilentRequest): Promise<NativeTokenRequest> {
        this.logger.trace("NativeInteractionClient - initializeNativeRequest called");

        const authority = request.authority || this.config.auth.authority;
        const canonicalAuthority = new UrlString(authority);
        canonicalAuthority.validateAsUri();

        const scopes = request && request.scopes || [];
        const scopeSet = new ScopeSet(scopes);
        scopeSet.appendScopes(OIDC_DEFAULT_SCOPES);

        if (request.prompt) {
            switch (request.prompt) {
                case PromptValue.NONE:
                case PromptValue.CONSENT:
                    this.logger.trace("initializeNativeRequest: prompt is compatible with native flow");
                    break;
                default:
                    this.logger.trace(`initializeNativeRequest: prompt = ${request.prompt} is not compatible with native flow`);
                    throw BrowserAuthError.createNativePromptParameterNotSupportedError();
            }
        }

        const instanceAware: boolean = !!(request.extraQueryParameters && request.extraQueryParameters.instance_aware);

        const validatedRequest: NativeTokenRequest = {
            ...request,
            accountId: this.accountId,
            clientId: this.config.auth.clientId,
            authority: canonicalAuthority.urlString,
            scopes: scopeSet.printScopes(),
            redirectUri: this.getRedirectUri(request.redirectUri),
            correlationId: this.correlationId,
            instance_aware: instanceAware,
            token_type: request.authenticationScheme,
            windowTitleSubstring: document.title,
            extraParameters: {
                ...request.extraQueryParameters,
                ...request.tokenQueryParameters
            },
            extendedExpiryToken: false // Make this configurable?
        };

        if (request.authenticationScheme === AuthenticationScheme.POP) {

            // add POP request type
            const shrParameters: SignedHttpRequestParameters = {
                resourceRequestUri: request.resourceRequestUri,
                resourceRequestMethod: request.resourceRequestMethod,
                shrClaims: request.shrClaims,
                shrNonce: request.shrNonce
            };

            const popTokenGenerator = new PopTokenGenerator(this.browserCrypto);
            const reqCnfData = await popTokenGenerator.generateCnf(shrParameters);

            // to reduce the URL length, it is recommended to send the hash of the req_cnf instead of the whole string
            validatedRequest.req_cnf = reqCnfData.reqCnfHash;
            validatedRequest.keyId = reqCnfData.kid;
        }

        if (this.apiId === ApiId.ssoSilent || this.apiId === ApiId.acquireTokenSilent_silentFlow) {
            validatedRequest.prompt = PromptValue.NONE;
        }

        return validatedRequest;
    }
}
