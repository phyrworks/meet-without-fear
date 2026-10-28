import { Router } from 'express';
import { ApiResponse, VersionCheckResponse } from '@meet-without-fear/shared';

const router = Router();

const DEFAULT_DOWNLOAD_URL = 'https://meetwithoutfear.com/download';

function readPositiveInt(value: string | undefined): number {
  const parsed = Number.parseInt(value ?? '0', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function readPlatformBuild(
  platform: 'ios' | 'android',
  iosKey: string,
  androidKey: string,
  fallbackKey: string,
): number {
  return readPositiveInt(
    (platform === 'ios' ? process.env[iosKey] : process.env[androidKey]) ?? process.env[fallbackKey],
  );
}

router.get('/version/check', (req, res) => {
  const platform = req.query.platform === 'android' ? 'android' : 'ios';
  const buildNumber = readPositiveInt(typeof req.query.buildNumber === 'string' ? req.query.buildNumber : undefined);

  const minBuild = readPlatformBuild(
    platform,
    'APP_MIN_BUILD_NUMBER_IOS',
    'APP_MIN_BUILD_NUMBER_ANDROID',
    'APP_MIN_BUILD_NUMBER',
  );
  const latestBuild = readPlatformBuild(
    platform,
    'APP_LATEST_BUILD_NUMBER_IOS',
    'APP_LATEST_BUILD_NUMBER_ANDROID',
    'APP_LATEST_BUILD_NUMBER',
  );
  const latestVersion = process.env.APP_LATEST_VERSION ?? '0.0.1';
  const downloadUrl =
    (platform === 'ios' ? process.env.APP_DOWNLOAD_URL_IOS : process.env.APP_DOWNLOAD_URL_ANDROID) ??
    process.env.APP_DOWNLOAD_URL ??
    DEFAULT_DOWNLOAD_URL;

  let updateStatus: VersionCheckResponse['updateStatus'] = 'up-to-date';
  if (minBuild > 0 && buildNumber < minBuild) {
    updateStatus = 'required-update';
  } else if (latestBuild > 0 && buildNumber < latestBuild) {
    updateStatus = 'optional-update';
  }

  const message =
    process.env.APP_UPDATE_MESSAGE ??
    (updateStatus === 'required-update'
      ? 'This version of Meet Without Fear is no longer supported. Please update to continue.'
      : updateStatus === 'optional-update'
        ? 'A new version of Meet Without Fear is available with improvements and bug fixes.'
        : undefined);

  const response: ApiResponse<VersionCheckResponse> = {
    success: true,
    data: {
      updateStatus,
      latestVersion,
      latestBuildNumber: latestBuild,
      message,
      downloadUrl,
    },
  };

  res.json(response);
});

export default router;
