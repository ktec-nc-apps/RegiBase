<?php

declare(strict_types=1);

namespace OCA\RegiBase\Controller;

use OCA\RegiBase\AppInfo\Application;
use OCP\App\IAppManager;
use OCP\AppFramework\Controller;
use OCP\AppFramework\Http\Attribute\NoAdminRequired;
use OCP\AppFramework\Http\Attribute\NoCSRFRequired;
use OCP\AppFramework\Http\ContentSecurityPolicy;
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
		Util::addScript(Application::APP_ID, 'vue-private');
		// KeePass (.kdbx) and other password managers, read and written in the browser:
		// kdbxweb (MIT) and the Argon2 of hash-wasm (MIT), see js/vendor/LICENSES.txt.
		Util::addScript(Application::APP_ID, 'vendor/kdbxweb.min');
		Util::addScript(Application::APP_ID, 'vendor/argon2.umd.min');
		Util::addScript(Application::APP_ID, 'pwmanager');
		Util::addScript(Application::APP_ID, 'regibase.dist');

		// Translate the pre-Vue loading text using the RegiBase language setting
		// ('auto' = follow Nextcloud) so it matches the in-app language.
		$user = $this->userSession->getUser();
		$lang = $user ? $this->config->getUserValue($user->getUID(), Application::APP_ID, 'language', 'auto') : 'auto';
		$lang = Application::OLD_LANGUAGES[$lang] ?? $lang; // shipped as "pt" until 2026-09, "zh" until 2026-10
		$l = $this->l10nFactory->get(Application::APP_ID, $lang === 'auto' ? null : $lang);

		$response = new TemplateResponse(Application::APP_ID, 'main', [
			'version' => $this->appManager->getAppVersion(Application::APP_ID),
			'loading' => $l->t('Loading…'),
		]);
		// Argon2, which KeePass files are locked with, runs as WebAssembly. A page may compile
		// WebAssembly only when its policy says so ('wasm-unsafe-eval': this does not allow
		// eval() of text). Only this page asks for it.
		$policy = new ContentSecurityPolicy();
		if (method_exists($policy, 'allowEvalWasm')) {
			$policy->allowEvalWasm(true);
		}
		$response->setContentSecurityPolicy($policy);
		return $response;
	}
}
