import { describe, expect, it, vi } from "vitest";
import type { ExtensionCommandContext, ExternalLoginConfig } from "../src/core/extensions/types.ts";
import type { AuthSelectorProvider } from "../src/modes/interactive/components/oauth-selector.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";

type FakeProvider = {
	id: string;
	name: string;
	auth: {
		oauth?: { name: string; login?: () => Promise<unknown> };
		apiKey?: { name: string; login?: () => Promise<unknown> };
	};
};

type FakeRuntime = {
	providers: FakeProvider[];
	configs: Map<string, { externalLogin?: ExternalLoginConfig }>;
	getProviders(): FakeProvider[];
	getProviderAuthStatus(providerId: string): { configured: boolean; source?: string; label?: string };
	isUsingOAuth(providerId: string): boolean;
	getRegisteredProviderConfig(providerId: string): { externalLogin?: ExternalLoginConfig } | undefined;
};

type FakeMode = {
	session: {
		modelRuntime: FakeRuntime;
		extensionRunner?: { createCommandContext(): ExtensionCommandContext };
	};
	getLoginProviderOptions(authType?: "oauth" | "api_key"): AuthSelectorProvider[];
	findLoginProviderOptions(providerRef: string): AuthSelectorProvider[];
	handleLoginCommand(providerRef?: string): Promise<void>;
	startProviderLogin(providerOption: AuthSelectorProvider): Promise<void>;
	showLoginProviderSelector(authType?: "oauth" | "api_key", initialSearchInput?: string): void;
	showLoginAuthTypeSelector(providerOptions?: AuthSelectorProvider[]): void;
	showLoginDialog(providerId: string, providerName: string): Promise<void>;
	showApiKeyLoginDialog(providerId: string, providerName: string): Promise<void>;
	showAmbientAuthDialog(providerOption: AuthSelectorProvider): void;
	showError(message: string): void;
};

const interactiveMethods = InteractiveMode.prototype as unknown as {
	getLoginProviderOptions(this: FakeMode, authType?: "oauth" | "api_key"): AuthSelectorProvider[];
	findLoginProviderOptions(this: FakeMode, providerRef: string): AuthSelectorProvider[];
	handleLoginCommand(this: FakeMode, providerRef?: string): Promise<void>;
	startProviderLogin(this: FakeMode, providerOption: AuthSelectorProvider): Promise<void>;
};

function createRuntime(
	providers: FakeProvider[],
	configs: Map<string, { externalLogin?: ExternalLoginConfig }> = new Map(),
	getProviderAuthStatus = () => ({ configured: false }),
): FakeRuntime {
	return {
		providers,
		configs,
		getProviders: () => providers,
		getProviderAuthStatus,
		isUsingOAuth: () => false,
		getRegisteredProviderConfig: (providerId) => configs.get(providerId),
	};
}

function createMode(
	runtime: FakeRuntime,
	options: { extensionRunner?: { createCommandContext(): ExtensionCommandContext } } = {},
): FakeMode {
	const mode = {} as FakeMode;
	mode.session = {
		modelRuntime: runtime,
		extensionRunner: options.extensionRunner,
	};
	mode.getLoginProviderOptions = (authType) => interactiveMethods.getLoginProviderOptions.call(mode, authType);
	mode.findLoginProviderOptions = (providerRef) => interactiveMethods.findLoginProviderOptions.call(mode, providerRef);
	mode.handleLoginCommand = (providerRef) => interactiveMethods.handleLoginCommand.call(mode, providerRef);
	mode.startProviderLogin = (providerOption) => interactiveMethods.startProviderLogin.call(mode, providerOption);
	mode.showLoginProviderSelector = vi.fn();
	mode.showLoginAuthTypeSelector = vi.fn();
	mode.showLoginDialog = vi.fn(async () => {});
	mode.showApiKeyLoginDialog = vi.fn(async () => {});
	mode.showAmbientAuthDialog = vi.fn();
	mode.showError = vi.fn();
	return mode;
}

describe("external provider login", () => {
	it.each(["oauth", "api_key"] as const)("shows one %s entry and suppresses native methods", (authType) => {
		const getProviderAuthStatus = vi.fn(() => ({ configured: true, source: "not-used" }));
		const runtime = createRuntime(
			[
				{
					id: "company-ai",
					name: "Company AI",
					auth: {
						oauth: { name: "Native account login" },
						apiKey: { name: "Native API key login" },
					},
				},
			],
			new Map([["company-ai", { externalLogin: { authType, handler: vi.fn(async () => {}) } }]]),
			getProviderAuthStatus,
		);
		const mode = createMode(runtime);

		expect(mode.getLoginProviderOptions()).toEqual([{ id: "company-ai", name: "Company AI", authType }]);
		expect(mode.getLoginProviderOptions(authType)).toEqual([{ id: "company-ai", name: "Company AI", authType }]);
		expect(mode.getLoginProviderOptions(authType === "oauth" ? "api_key" : "oauth")).toEqual([]);
		expect(getProviderAuthStatus).not.toHaveBeenCalled();
	});

	it("resolves /login by provider id or name and passes the live command context", async () => {
		const context = {} as ExtensionCommandContext;
		const handler = vi.fn(async (_context: ExtensionCommandContext) => {});
		const runtime = createRuntime(
			[{ id: "company-ai", name: "Company AI", auth: { apiKey: { name: "Placeholder key" } } }],
			new Map([["company-ai", { externalLogin: { authType: "oauth", handler } }]]),
		);
		const createCommandContext = vi.fn(() => context);
		const mode = createMode(runtime, { extensionRunner: { createCommandContext } });

		expect(mode.findLoginProviderOptions("company-ai")).toMatchObject([
			{ id: "company-ai", name: "Company AI", authType: "oauth" },
		]);
		await mode.handleLoginCommand("company-ai");
		await mode.handleLoginCommand("Company AI");

		expect(createCommandContext).toHaveBeenCalledTimes(2);
		expect(handler).toHaveBeenNthCalledWith(1, context);
		expect(handler).toHaveBeenNthCalledWith(2, context);
		expect(mode.showLoginDialog).not.toHaveBeenCalled();
		expect(mode.showApiKeyLoginDialog).not.toHaveBeenCalled();
	});

	it("reports a missing extension runner and handler failures through the UI", async () => {
		const handler = vi.fn(async (_context: ExtensionCommandContext) => {
			throw new Error("provider unavailable");
		});
		const runtime = createRuntime(
			[{ id: "company-ai", name: "Company AI", auth: { apiKey: { name: "Placeholder key" } } }],
			new Map([["company-ai", { externalLogin: { authType: "api_key", handler } }]]),
		);
		const option: AuthSelectorProvider = { id: "company-ai", name: "Company AI", authType: "api_key" };
		const withoutRunner = createMode(runtime);
		await withoutRunner.startProviderLogin(option);
		expect(withoutRunner.showError).toHaveBeenCalledWith(
			"Could not start login for Company AI: extension context is unavailable.",
		);
		expect(handler).not.toHaveBeenCalled();

		const mode = createMode(runtime, {
			extensionRunner: { createCommandContext: () => ({}) as ExtensionCommandContext },
		});
		await mode.startProviderLogin(option);
		expect(mode.showError).toHaveBeenCalledWith("Failed to login to Company AI: provider unavailable");
	});

	it("keeps native OAuth, API-key, and ambient-auth routes for ordinary providers", async () => {
		const runtime = createRuntime([
			{
				id: "oauth-provider",
				name: "OAuth Provider",
				auth: { oauth: { name: "OAuth" } },
			},
			{
				id: "key-provider",
				name: "Key Provider",
				auth: { apiKey: { name: "API key", login: async () => ({}) } },
			},
			{
				id: "ambient-provider",
				name: "Ambient Provider",
				auth: { apiKey: { name: "Cloud credentials" } },
			},
		]);
		const mode = createMode(runtime);
		const loginOptions = mode.getLoginProviderOptions();
		const oauthOption = loginOptions.find((option) => option.id === "oauth-provider");
		const apiKeyOption = loginOptions.find((option) => option.id === "key-provider");
		const ambientOption = loginOptions.find((option) => option.id === "ambient-provider");

		expect(oauthOption).toBeDefined();
		expect(apiKeyOption).toBeDefined();
		expect(ambientOption).toBeDefined();
		await mode.startProviderLogin(oauthOption!);
		await mode.startProviderLogin(apiKeyOption!);
		await mode.startProviderLogin(ambientOption!);

		expect(mode.showLoginDialog).toHaveBeenCalledWith("oauth-provider", "OAuth Provider");
		expect(mode.showApiKeyLoginDialog).toHaveBeenCalledWith("key-provider", "Key Provider");
		expect(mode.showAmbientAuthDialog).toHaveBeenCalledWith(ambientOption);
	});
});
