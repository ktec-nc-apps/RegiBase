<?php

declare(strict_types=1);

namespace OCA\RegiBase\Service;

use OCA\RegiBase\AppInfo\Application;
use OCP\App\IAppManager;
use OCP\IConfig;
use OCP\IGroupManager;
use OCP\IUserManager;

/**
 * The AI assistant of RegiBase (the owner, 2026-10-04), made the way FormulaBase's is.
 *
 * RegiBase has no AI of its own: it asks AI-Hub (ai_hub), the AI gateway whose key,
 * model and limits are set once in AI-Hub's admin settings. Without AI-Hub the
 * assistant is not offered at all, and its admin settings are shown greyed out.
 *
 * What the assistant may do is set by the administrator: whether it is on, who may
 * use it, what it may read (read only -- it never changes anything), and whether it
 * may search the web. For now it only reads what the browser sends with a question:
 * the names of the collections, the open collection's field definitions and its
 * records -- never a secret field's value. Secret fields are encrypted in the
 * browser; the server never sees the key or the plaintext, and the assistant is
 * never handed a secret value, decrypted or encrypted.
 */
class AiService {
	public const KEY_ENABLED = 'ai_enabled';
	public const KEY_USERS = 'ai_users';
	public const KEY_GROUPS = 'ai_groups';
	public const KEY_READ = 'ai_read';
	public const KEY_SEARCH = 'ai_search';
	/**
	 * What the assistant may be allowed to read, all sent by the browser with the
	 * question and all free of secret values: the collection names with the open
	 * collection's field definitions, and the open collection's non-secret records.
	 */
	public const SOURCES = ['collections', 'records'];
	/** The name RegiBase's assistant is registered under at AI-Hub. */
	public const SCENARIO = 'assistant';
	private const HUB = 'ai_hub';
	private const HUB_SERVICE = '\\OCA\\AIHub\\Service\\HubService';

	public function __construct(
		private IConfig $config,
		private IAppManager $apps,
		private IGroupManager $groups,
		private IUserManager $users,
	) {
	}

	/** AI-Hub is installed and switched on. */
	public function hubPresent(): bool {
		return $this->apps->isEnabledForUser(self::HUB) && class_exists(self::HUB_SERVICE);
	}

	/** @return object|null AI-Hub's HubService */
	private function hub(): ?object {
		return $this->hubPresent() ? \OCP\Server::get(ltrim(self::HUB_SERVICE, '\\')) : null;
	}

	/**
	 * Tell AI-Hub what RegiBase's assistant is. Called when the app boots, in every
	 * request: the hub keeps scenarios in memory only, and the request that works
	 * out an answer is not the one that asked.
	 */
	public function registerScenario(): void {
		$hub = $this->hub();
		if ($hub === null || $hub->hasScenario(Application::APP_ID, self::SCENARIO)) {
			return;
		}
		$hub->registerScenario(Application::APP_ID, self::SCENARIO, [
			'system' => AiScenario::base(),
			// Whether a question may search is decided per question, from the
			// administrator's RegiBase settings; the language is in the prompt itself.
			'search' => true,
			'language' => false,
			// Who may ask is the administrator's RegiBase setting, and the hub holds
			// to it on every way in -- not only through RegiBase's own controller.
			'allow' => fn (string $uid): bool => $this->allowed($uid),
		]);
	}

	/**
	 * What AI-Hub can offer now.
	 *
	 * @return array{present: bool, ready: bool, reason: string, provider: string, mode: string, model: string, search: bool}
	 */
	public function hubStatus(): array {
		$hub = $this->hub();
		if ($hub === null) {
			return ['present' => false, 'ready' => false, 'reason' => 'absent', 'provider' => '', 'mode' => '', 'model' => '', 'search' => false];
		}
		return ['present' => true] + $hub->status();
	}

	/**
	 * Whether images can go with a question now: AI-Hub checks the connection this app
	 * is given (an older AI-Hub says nothing about images, which reads as no).
	 */
	public function imagesOk(): bool {
		$hub = $this->hub();
		return $hub !== null && !empty($hub->status(Application::APP_ID)['images']);
	}

	/** @return array{enabled: bool, users: string, groups: list<string>, read: list<string>, search: bool} */
	public function settings(): array {
		$get = fn (string $k, string $d) => $this->config->getAppValue(Application::APP_ID, $k, $d);
		$groups = json_decode($get(self::KEY_GROUPS, '[]'), true);
		$read = json_decode($get(self::KEY_READ, '[]'), true);
		return [
			'enabled' => $get(self::KEY_ENABLED, 'no') === 'yes',
			'users' => $get(self::KEY_USERS, 'all') === 'groups' ? 'groups' : 'all',
			'groups' => is_array($groups) ? array_values(array_filter($groups, 'is_string')) : [],
			'read' => is_array($read) ? array_values(array_intersect(self::SOURCES, $read)) : [],
			'search' => $get(self::KEY_SEARCH, 'no') === 'yes',
		];
	}

	/** @param array{enabled?: mixed, users?: mixed, groups?: mixed, read?: mixed, search?: mixed} $in */
	public function saveSettings(array $in): array {
		$set = fn (string $k, string $v) => $this->config->setAppValue(Application::APP_ID, $k, $v);
		$set(self::KEY_ENABLED, !empty($in['enabled']) ? 'yes' : 'no');
		$set(self::KEY_USERS, ($in['users'] ?? '') === 'groups' ? 'groups' : 'all');
		$groups = is_array($in['groups'] ?? null) ? $in['groups'] : [];
		$groups = array_values(array_filter($groups, fn ($g) => is_string($g) && $this->groups->groupExists($g)));
		$set(self::KEY_GROUPS, json_encode($groups));
		$read = is_array($in['read'] ?? null) ? $in['read'] : [];
		$set(self::KEY_READ, json_encode(array_values(array_intersect(self::SOURCES, $read))));
		$set(self::KEY_SEARCH, !empty($in['search']) ? 'yes' : 'no');
		return $this->settings();
	}

	/** Whether this person may use the assistant, as the administrator has set it. */
	public function allowed(string $uid): bool {
		$s = $this->settings();
		if (!$s['enabled'] || !$this->hubPresent()) {
			return false;
		}
		if ($s['users'] === 'all') {
			return true;
		}
		$user = $this->users->get($uid);
		if ($user === null) {
			return false;
		}
		foreach ($this->groups->getUserGroupIds($user) as $g) {
			if (in_array($g, $s['groups'], true)) {
				return true;
			}
		}
		return false;
	}

	/**
	 * What the browser needs to know: whether to show the handle at all, whether a
	 * question can be asked now, and what the assistant may read.
	 */
	public function status(string $uid): array {
		if (!$this->allowed($uid)) {
			return ['show' => false];
		}
		$hub = $this->hubStatus();
		$s = $this->settings();
		return [
			'show' => true,
			'ready' => $hub['ready'],
			'reason' => $hub['reason'],
			'model' => $hub['model'],
			'read' => $s['read'],
			'search' => $s['search'] && $hub['search'],
			// whether the person may paste or drop images into a question
			'images' => $this->imagesOk(),
		];
	}

	/**
	 * Ask the assistant. What the administrator allows and what is on the screen are
	 * put into the prompt here, on the server; the browser sends only the
	 * conversation and the open collection. Secret field values are never passed on:
	 * the context is built from the field definitions, and a value for a field the
	 * definition marks secret is dropped here too, as a second line of defence.
	 *
	 * @param list<array{role: string, text: string, images?: int}> $history
	 * @param array<string, mixed> $context
	 * @param list<array{type: string, data: string}> $images Pasted or dropped into the question; AI-Hub checks them (kind, size, number).
	 * @return array{id?: string, error?: string}
	 */
	public function ask(string $uid, array $history, string $message, array $context, string $lang, string $conversation, array $images = []): array {
		if (!$this->allowed($uid)) {
			return ['error' => 'not-allowed'];
		}
		$images = array_values(array_filter($images, 'is_array'));
		if ($images !== [] && !$this->imagesOk()) {
			return ['error' => 'no-images'];
		}
		$st = $this->status($uid);
		// A turn that had images says how many ('images' => n); AI-Hub puts a mark in their place.
		$messages = array_map(static fn (array $t) => ['role' => $t['role'], 'text' => $t['text']] + (is_int($t['images'] ?? null) && $t['images'] > 0 ? ['images' => min($t['images'], 99)] : []),
			array_slice(array_values(array_filter($history, static fn ($t) => is_array($t)
			&& in_array($t['role'] ?? '', ['user', 'assistant'], true) && is_string($t['text'] ?? null))), -30));
		$messages[] = ['role' => 'user', 'text' => $message];
		$this->registerScenario();
		$options = [
			'context' => AiScenario::perQuestion($st['read'], $st['search'], $context, $lang),
			'search' => $st['search'],
			'conversation' => $conversation,
		];
		if ($images !== []) {
			$options['images'] = $images;
		}
		return $this->hub()->ask($uid, Application::APP_ID, self::SCENARIO, $messages, $options);
	}

	/** @return array{state: string, text?: string, error?: string} */
	public function result(string $uid, string $id): array {
		$hub = $this->hub();
		return $hub === null ? ['state' => 'unknown'] : $hub->result($uid, $id);
	}

	/** Drop a remembered conversation, so "New conversation" forgets the server-side memory. */
	public function forget(string $uid, string $conversation): void {
		$hub = $this->hub();
		if ($hub !== null && $conversation !== '') {
			$hub->forgetConversation($uid, Application::APP_ID, $conversation);
		}
	}
}
