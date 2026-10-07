<?php

declare(strict_types=1);

namespace OCA\RegiBase\Controller;

use OCA\RegiBase\AppInfo\Application;
use OCA\RegiBase\Service\AiService;
use OCP\AppFramework\Controller;
use OCP\AppFramework\Http;
use OCP\AppFramework\Http\Attribute\NoAdminRequired;
use OCP\AppFramework\Http\JSONResponse;
use OCP\IConfig;
use OCP\IRequest;
use OCP\IUserSession;

/**
 * The AI assistant's questions from the browser -- may I, ask this, is the answer
 * there yet, forget this conversation -- and the administrator's settings.
 */
class AiController extends Controller {
	public function __construct(
		IRequest $request,
		private AiService $ai,
		private IUserSession $userSession,
		private IConfig $config,
	) {
		parent::__construct(Application::APP_ID, $request);
	}

	private function uid(): ?string {
		$user = $this->userSession->getUser();
		return $user === null ? null : $user->getUID();
	}

	#[NoAdminRequired]
	public function status(): JSONResponse {
		$uid = $this->uid();
		return new JSONResponse($uid === null ? ['show' => false] : $this->ai->status($uid));
	}

	#[NoAdminRequired]
	public function ask(): JSONResponse {
		$uid = $this->uid();
		if ($uid === null) {
			return new JSONResponse(['error' => 'not-allowed'], Http::STATUS_FORBIDDEN);
		}
		$history = $this->request->getParam('history', []);
		$context = $this->request->getParam('context', []);
		$message = $this->request->getParam('message', '');
		$conversation = $this->request->getParam('conversation', '');
		$images = $this->request->getParam('images', []);
		// The in-app language override first, then Nextcloud's own language.
		$lang = $this->config->getUserValue($uid, Application::APP_ID, 'language', 'auto');
		$lang = Application::OLD_LANGUAGES[$lang] ?? $lang;
		if ($lang === '' || $lang === 'auto') {
			$lang = $this->config->getUserValue($uid, 'core', 'lang', $this->config->getSystemValueString('default_language', 'en'));
		}
		$out = $this->ai->ask(
			$uid,
			is_array($history) ? $history : [],
			is_string($message) ? mb_substr($message, 0, 20000) : '',
			is_array($context) ? $context : [],
			str_starts_with((string)$lang, 'ja') ? 'ja' : (string)$lang,
			is_string($conversation) ? $conversation : '',
			is_array($images) ? $images : [],
		);
		$status = isset($out['error']) ? ($out['error'] === 'not-allowed' ? Http::STATUS_FORBIDDEN : Http::STATUS_SERVICE_UNAVAILABLE) : Http::STATUS_OK;
		return new JSONResponse($out, $status);
	}

	#[NoAdminRequired]
	public function result(string $id): JSONResponse {
		$uid = $this->uid();
		return new JSONResponse($uid === null ? ['state' => 'unknown'] : $this->ai->result($uid, $id));
	}

	#[NoAdminRequired]
	public function forget(): JSONResponse {
		$uid = $this->uid();
		$conversation = $this->request->getParam('conversation', '');
		if ($uid !== null && is_string($conversation)) {
			$this->ai->forget($uid, $conversation);
		}
		return new JSONResponse(['ok' => true]);
	}

	/** Administrators only (no NoAdminRequired). */
	public function saveAdmin(): JSONResponse {
		if (!$this->ai->hubPresent()) {
			return new JSONResponse(['error' => 'AI-Hub is not installed'], Http::STATUS_CONFLICT);
		}
		return new JSONResponse($this->ai->saveSettings([
			'enabled' => $this->request->getParam('enabled'),
			'users' => $this->request->getParam('users'),
			'groups' => $this->request->getParam('groups', []),
			'read' => $this->request->getParam('read', []),
			'search' => $this->request->getParam('search'),
		]));
	}
}
