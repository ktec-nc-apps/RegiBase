<?php

declare(strict_types=1);

namespace OCA\RegiBase\Controller;

use OCA\RegiBase\AppInfo\Application;
use OCP\App\IAppManager;
use OCP\AppFramework\Controller;
use OCP\AppFramework\Http\Attribute\NoAdminRequired;
use OCP\AppFramework\Http\Attribute\NoCSRFRequired;
use OCP\AppFramework\Http\TemplateResponse;
use OCP\IConfig;
use OCP\IRequest;
use OCP\IUserSession;
use OCP\L10N\IFactory;
use OCP\Util;

class PageController extends Controller {
	public function __construct(
		IRequest $request,
		private IAppManager $appManager,
		private IConfig $config,
		private IUserSession $userSession,
		private IFactory $l10nFactory,
	) {
		parent::__construct(Application::APP_ID, $request);
	}

	#[NoAdminRequired]
	#[NoCSRFRequired]
	public function index(): TemplateResponse {
		Util::addStyle(Application::APP_ID, 'regibase');
		// Runtime-only Vue + precompiled render function (no template compiler → no eval).
		Util::addScript(Application::APP_ID, 'vue.runtime.global.prod');
		Util::addScript(Application::APP_ID, 'regibase.dist');

		// Translate the pre-Vue loading text using the RegiBase language setting
		// ('auto' = follow Nextcloud) so it matches the in-app language.
		$user = $this->userSession->getUser();
		$lang = $user ? $this->config->getUserValue($user->getUID(), Application::APP_ID, 'language', 'auto') : 'auto';
		$l = $this->l10nFactory->get(Application::APP_ID, $lang === 'auto' ? null : $lang);

		return new TemplateResponse(Application::APP_ID, 'main', [
			'version' => $this->appManager->getAppVersion(Application::APP_ID),
			'loading' => $l->t('Loading…'),
		]);
	}
}
