import { DiscordSDK, DiscordSDKMock } from '@discord/embedded-app-sdk';

const queryParams = new URLSearchParams(window.location.search);
export const isEmbedded = queryParams.get('frame_id') != null;

let sdk: DiscordSDK | DiscordSDKMock;

if (isEmbedded) {
	sdk = new DiscordSDK(import.meta.env.VITE_CLIENT_ID);
} else {
	sdk = new DiscordSDKMock(
		import.meta.env.VITE_CLIENT_ID,
		'mock_guild_id',
		'mock_channel_id',
		'mock_location_id'
	);
}

export const discordSdk = sdk;
