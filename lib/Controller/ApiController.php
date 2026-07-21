<?php

declare(strict_types=1);

namespace OCA\RegiBase\Controller;

use OCA\RegiBase\AppInfo\Application;
use OCA\RegiBase\Service\ContactsImport;
use OCA\RegiBase\Service\DataImport;
use OCA\RegiBase\Service\ForbiddenException;
use OCA\RegiBase\Service\LockedException;
use OCA\RegiBase\Service\ImageService;
use OCA\RegiBase\Service\RegiBaseService;
use OCA\RegiBase\Service\TablesBridge;
use OCA\RegiBase\Service\TemplateService;
use OCA\DAV\CardDAV\CardDavBackend;
use OCP\Contacts\IManager as IContactsManager;
use OCP\AppFramework\Controller;
use OCP\AppFramework\Db\DoesNotExistException;
use OCP\AppFramework\Http;
use OCP\AppFramework\Http\Attribute\NoAdminRequired;
use OCP\AppFramework\Http\Attribute\NoCSRFRequired;
use OCP\AppFramework\Http\DataDisplayResponse;
use OCP\AppFramework\Http\DataDownloadResponse;
use OCP\AppFramework\Http\JSONResponse;
use OCP\IConfig;
use OCP\IL10N;
use OCP\IRequest;
use OCP\ITempManager;
use OCP\IUserManager;
use OCP\IUserSession;
use OCP\L10N\IFactory;

class ApiController extends Controller {
	private const ALLOWED_THEMES = ['auto', 'dark', 'light'];

	public function __construct(
		IRequest $request,
		private RegiBaseService $service,
		private ImageService $images,
		private IUserSession $userSession,
		private IConfig $config,
		private IL10N $l,
		private IFactory $l10nFactory,
		private IUserManager $userManager,
		private ITempManager $tempManager,
		private IContactsManager $contactsManager,
		private CardDavBackend $cardDavBackend,
		private TablesBridge $tablesBridge,
		private TemplateService $tplService,
	) {
		parent::__construct(Application::APP_ID, $request);
	}

	/** Non-system address books the user can read from. @return \OCP\IAddressBook[] */
	private function userAddressBooks(): array {
		$books = [];
		foreach ($this->contactsManager->getUserAddressBooks() as $b) {
			if (!$b->isSystemAddressBook()) {
				$books[] = $b;
			}
		}
		return $books;
	}

	/** Embedded photo of a contact (from its stored vCard), or null. @return array{ext:string,data:string}|null */
	private function contactPhoto(int $addressBookId, string $cardUri): ?array {
		if ($cardUri === '') {
			return null;
		}
		try {
			$card = $this->cardDavBackend->getCard($addressBookId, $cardUri);
		} catch (\Throwable $e) {
			return null;
		}
		if (!is_array($card) || !isset($card['carddata'])) {
			return null;
		}
		$val = ContactsImport::photoValueFromVcard((string)$card['carddata']);
		return $val !== '' ? ContactsImport::decodePhoto($val) : null;
	}

	#[NoAdminRequired]
	public function contactsAddressbooks(): JSONResponse {
		if (!$this->contactsManager->isEnabled()) {
			return new JSONResponse(['enabled' => false, 'books' => []]);
		}
		$books = [];
		foreach ($this->userAddressBooks() as $b) {
			$found = $b->search('', ['FN'], ['limit' => 100000]);
			$books[] = ['key' => (string)$b->getKey(), 'name' => (string)$b->getDisplayName(), 'count' => count($found)];
		}
		return new JSONResponse(['enabled' => true, 'books' => $books]);
	}

	#[NoAdminRequired]
	public function contactsImport(): JSONResponse {
		$uid = $this->uid();
		$l = $this->appL10n();
		if (!$this->contactsManager->isEnabled()) {
			return new JSONResponse(['error' => $l->t('The Contacts app is not enabled')], Http::STATUS_BAD_REQUEST);
		}
		$bookKey = (string)$this->request->getParam('addressbook', 'all');
		$name = trim((string)$this->request->getParam('name', ''));

		$records = [];
		foreach ($this->userAddressBooks() as $b) {
			if ($bookKey !== 'all' && (string)$b->getKey() !== $bookKey) {
				continue;
			}
			$bookId = (int)$b->getKey();
			foreach ($b->search('', ['FN'], ['types' => true, 'limit' => 100000]) as $c) {
				$rec = ContactsImport::toRecord($c);
				if ($rec === null) {
					continue;
				}
				// Photos are externalised to a URI in search results, so read the
				// stored vCard and pull the embedded image out of it.
				$photo = $this->contactPhoto($bookId, (string)($c['URI'] ?? ''));
				if ($photo !== null) {
					try {
						$rec['photo'] = (string)$this->images->saveRaw($uid, 'contact-photo.' . $photo['ext'], $photo['data']);
					} catch (\Throwable $e) {
						/* skip the photo but keep the contact */
					}
				}
				$records[] = $rec;
			}
		}
		if ($name === '') {
			$name = $l->t('Contacts');
		}
		$created = $this->service->createCollection($uid, [
			'name' => $name,
			'icon' => '👤',
			'color' => '#0ea5e9',
			'view' => 'card',
			'fields' => ContactsImport::fields($l),
		]);
		$cid = (int)$created['id'];
		$imported = $this->service->bulkAddRecords($uid, $cid, $records);
		return new JSONResponse(['collectionId' => $cid, 'imported' => $imported]);
	}

	#[NoAdminRequired]
	public function tablesList(): JSONResponse {
		$uid = $this->uid();
		if (!$this->tablesBridge->available()) {
			return new JSONResponse(['available' => false, 'tables' => []]);
		}
		try {
			return new JSONResponse(['available' => true, 'tables' => $this->tablesBridge->listTables($uid)]);
		} catch (\Throwable $e) {
			return new JSONResponse(['available' => true, 'tables' => [], 'error' => $e->getMessage()]);
		}
	}

	#[NoAdminRequired]
	public function tablesImport(): JSONResponse {
		$uid = $this->uid();
		$l = $this->appL10n();
		if (!$this->tablesBridge->available()) {
			return new JSONResponse(['error' => $l->t('The Tables app is not enabled')], Http::STATUS_BAD_REQUEST);
		}
		$tableId = (int)$this->request->getParam('tableId', 0);
		if ($tableId <= 0) {
			return new JSONResponse(['error' => $l->t('No table selected')], Http::STATUS_BAD_REQUEST);
		}
		$name = trim((string)$this->request->getParam('name', ''));
		try {
			$payload = $this->tablesBridge->buildImport($uid, $tableId);
		} catch (\Throwable $e) {
			return new JSONResponse(['error' => $e->getMessage()], Http::STATUS_BAD_REQUEST);
		}
		if ($name !== '') {
			$payload['name'] = $name;
		}
		$records = $payload['records'];
		unset($payload['records']);
		$created = $this->service->createCollection($uid, $payload);
		$cid = (int)$created['id'];
		$imported = $this->service->bulkAddRecords($uid, $cid, $records);
		return new JSONResponse(['collectionId' => $cid, 'imported' => $imported]);
	}

	#[NoAdminRequired]
	public function tablesExport(int $id): JSONResponse {
		$uid = $this->uid();
		$l = $this->appL10n();
		if (!$this->tablesBridge->available()) {
			return new JSONResponse(['error' => $l->t('The Tables app is not enabled')], Http::STATUS_BAD_REQUEST);
		}
		try {
			$coll = $this->service->getCollection($uid, $id);
			$records = $this->service->listRecords($uid, $id, null, null);
			$res = $this->tablesBridge->exportCollection(
				$uid,
				(string)$coll['name'],
				(string)($coll['icon'] ?? ''),
				(string)($coll['description'] ?? ''),
				$coll['fields'] ?? [],
				$records
			);
			return new JSONResponse($res);
		} catch (DoesNotExistException $e) {
			return $this->notFound();
		} catch (ForbiddenException $e) {
			return $this->forbidden();
		} catch (\Throwable $e) {
			return new JSONResponse(['error' => $e->getMessage()], Http::STATUS_BAD_REQUEST);
		}
	}

	/**
	 * IL10N for the user's RegiBase language setting ('auto' = follow Nextcloud).
	 * Used so built-in templates match the in-app language, not just the NC language.
	 */
	private function appL10n(): IL10N {
		$lang = $this->config->getUserValue($this->uid(), Application::APP_ID, 'language', 'auto');
		if ($lang !== 'auto' && in_array($lang, $this->languageCodes(), true)) {
			return $this->l10nFactory->get(Application::APP_ID, $lang);
		}
		return $this->l;
	}

	private function uid(): string {
		$u = $this->userSession->getUser();
		return $u ? $u->getUID() : '';
	}

	private function notFound(): JSONResponse {
		return new JSONResponse(['error' => 'not found'], Http::STATUS_NOT_FOUND);
	}

	private function forbidden(): JSONResponse {
		return new JSONResponse(['error' => $this->appL10n()->t('You do not have permission to do that')], Http::STATUS_FORBIDDEN);
	}

	private function locked(): JSONResponse {
		return new JSONResponse(['error' => $this->appL10n()->t('This shared collection is locked'), 'code' => 'locked'], Http::STATUS_FORBIDDEN);
	}

	#[NoAdminRequired]
	public function templates(): JSONResponse {
		return new JSONResponse($this->tplService->merged($this->appL10n(), $this->uid()));
	}

	#[NoAdminRequired]
	public function createTemplate(): JSONResponse {
		$body = $this->request->getParams();
		try {
			if (isset($body['from_collection'])) {
				$t = $this->tplService->fromCollection($this->uid(), (int)$body['from_collection'], $body['name'] ?? null);
			} else {
				$t = $this->tplService->create($this->uid(), $body);
			}
			return new JSONResponse($t, Http::STATUS_CREATED);
		} catch (DoesNotExistException $e) {
			return $this->notFound();
		} catch (\Throwable $e) {
			return new JSONResponse(['error' => $e->getMessage()], Http::STATUS_BAD_REQUEST);
		}
	}

	#[NoAdminRequired]
	public function updateTemplate(int $id): JSONResponse {
		try {
			return new JSONResponse($this->tplService->update($this->uid(), $id, $this->request->getParams()));
		} catch (DoesNotExistException $e) {
			return $this->notFound();
		} catch (\Throwable $e) {
			return new JSONResponse(['error' => $e->getMessage()], Http::STATUS_BAD_REQUEST);
		}
	}

	#[NoAdminRequired]
	public function deleteTemplate(int $id): JSONResponse {
		try {
			$this->tplService->delete($this->uid(), $id);
			return new JSONResponse(['ok' => true]);
		} catch (DoesNotExistException $e) {
			return $this->notFound();
		}
	}

	#[NoAdminRequired]
	public function editBuiltinTemplate(string $key): JSONResponse {
		try {
			return new JSONResponse($this->tplService->editBuiltin($this->uid(), $key, $this->request->getParams(), $this->appL10n()), Http::STATUS_CREATED);
		} catch (\Throwable $e) {
			return new JSONResponse(['error' => $e->getMessage()], Http::STATUS_BAD_REQUEST);
		}
	}

	#[NoAdminRequired]
	public function resetBuiltinTemplate(string $key): JSONResponse {
		$this->tplService->resetBuiltin($this->uid(), $key);
		return new JSONResponse(['ok' => true]);
	}

	#[NoAdminRequired]
	public function duplicateCollection(int $id): JSONResponse {
		$withRecords = filter_var($this->request->getParam('with_records', false), FILTER_VALIDATE_BOOLEAN);
		$name = $this->request->getParam('name', null);
		try {
			return new JSONResponse($this->service->duplicateCollection($this->uid(), $id, $withRecords, $name !== null ? (string)$name : null), Http::STATUS_CREATED);
		} catch (DoesNotExistException $e) {
			return $this->notFound();
		} catch (\Throwable $e) {
			return new JSONResponse(['error' => $e->getMessage()], Http::STATUS_BAD_REQUEST);
		}
	}

	#[NoAdminRequired]
	public function collections(): JSONResponse {
		return new JSONResponse($this->service->listCollections($this->uid()));
	}

	#[NoAdminRequired]
	public function getCollection(int $id): JSONResponse {
		try {
			return new JSONResponse($this->service->getCollection($this->uid(), $id));
		} catch (LockedException $e) {
			return $this->locked();
		} catch (DoesNotExistException $e) {
			return $this->notFound();
		}
	}

	#[NoAdminRequired]
	public function reorderCollections(): JSONResponse {
		$ids = $this->request->getParam('ids', []);
		$ids = is_array($ids) ? $ids : [];
		return new JSONResponse(['changed' => $this->service->reorderCollections($this->uid(), $ids)]);
	}

	#[NoAdminRequired]
	public function createCollection(): JSONResponse {
		$body = $this->request->getParams();
		$c = $this->service->createCollection($this->uid(), $body, $this->appL10n());
		return new JSONResponse($c, Http::STATUS_CREATED);
	}

	#[NoAdminRequired]
	public function updateCollection(int $id): JSONResponse {
		try {
			return new JSONResponse($this->service->updateCollection($this->uid(), $id, $this->request->getParams()));
		} catch (LockedException $e) {
			return $this->locked();
		} catch (ForbiddenException $e) {
			return $this->forbidden();
		} catch (DoesNotExistException $e) {
			return $this->notFound();
		}
	}

	#[NoAdminRequired]
	public function deleteCollection(int $id): JSONResponse {
		try {
			$this->service->deleteCollection($this->uid(), $id);
			return new JSONResponse(['ok' => true]);
		} catch (DoesNotExistException $e) {
			return $this->notFound();
		}
	}

	#[NoAdminRequired]
	public function putFields(int $id): JSONResponse {
		$fields = $this->request->getParam('fields');
		if (!is_array($fields)) {
			return new JSONResponse(['error' => 'fields[] required'], Http::STATUS_BAD_REQUEST);
		}
		try {
			return new JSONResponse($this->service->replaceFields($this->uid(), $id, $fields));
		} catch (DoesNotExistException $e) {
			return $this->notFound();
		}
	}

	#[NoAdminRequired]
	public function records(int $id): JSONResponse {
		try {
			$q = $this->request->getParam('q');
			$sort = $this->request->getParam('sort');
			return new JSONResponse($this->service->listRecords($this->uid(), $id, $q, $sort));
		} catch (LockedException $e) {
			return $this->locked();
		} catch (DoesNotExistException $e) {
			return $this->notFound();
		}
	}

	#[NoAdminRequired]
	public function reorderRecords(int $id): JSONResponse {
		try {
			$ids = $this->request->getParam('ids', []);
			$ids = is_array($ids) ? $ids : [];
			$changed = $this->service->reorderRecords($this->uid(), $id, $ids);
			return new JSONResponse(['changed' => $changed]);
		} catch (LockedException $e) {
			return $this->locked();
		} catch (ForbiddenException $e) {
			return $this->forbidden();
		} catch (DoesNotExistException $e) {
			return $this->notFound();
		}
	}

	#[NoAdminRequired]
	public function createRecord(int $id): JSONResponse {
		try {
			$data = $this->request->getParam('data', []);
			return new JSONResponse($this->service->createRecord($this->uid(), $id, is_array($data) ? $data : []), Http::STATUS_CREATED);
		} catch (LockedException $e) {
			return $this->locked();
		} catch (ForbiddenException $e) {
			return $this->forbidden();
		} catch (DoesNotExistException $e) {
			return $this->notFound();
		}
	}

	#[NoAdminRequired]
	public function getRecord(int $id): JSONResponse {
		try {
			return new JSONResponse($this->service->getRecord($this->uid(), $id));
		} catch (DoesNotExistException $e) {
			return $this->notFound();
		}
	}

	#[NoAdminRequired]
	public function updateRecord(int $id): JSONResponse {
		try {
			$data = $this->request->getParam('data', []);
			return new JSONResponse($this->service->updateRecord($this->uid(), $id, is_array($data) ? $data : []));
		} catch (LockedException $e) {
			return $this->locked();
		} catch (ForbiddenException $e) {
			return $this->forbidden();
		} catch (DoesNotExistException $e) {
			return $this->notFound();
		}
	}

	#[NoAdminRequired]
	public function deleteRecord(int $id): JSONResponse {
		try {
			$this->service->deleteRecord($this->uid(), $id);
			return new JSONResponse(['ok' => true]);
		} catch (LockedException $e) {
			return $this->locked();
		} catch (ForbiddenException $e) {
			return $this->forbidden();
		} catch (DoesNotExistException $e) {
			return $this->notFound();
		}
	}

	#[NoAdminRequired]
	public function deleteRecords(): JSONResponse {
		$ids = $this->request->getParam('ids');
		if (!is_array($ids) || count($ids) === 0) {
			return new JSONResponse(['error' => 'ids required'], Http::STATUS_BAD_REQUEST);
		}
		return new JSONResponse(['deleted' => $this->service->deleteRecords($this->uid(), $ids)]);
	}

	#[NoAdminRequired]
	public function transfer(): JSONResponse {
		try {
			return new JSONResponse($this->service->transferRecords($this->uid(), $this->request->getParams()));
		} catch (DoesNotExistException $e) {
			return $this->notFound();
		} catch (\RuntimeException $e) {
			return new JSONResponse(['error' => $this->appL10n()->t($e->getMessage())], Http::STATUS_BAD_REQUEST);
		}
	}

	#[NoAdminRequired]
	public function importAnalyze(): JSONResponse {
		$csv = (string)$this->request->getParam('csv', '');
		try {
			return new JSONResponse(DataImport::analyze($csv, $this->appL10n()));
		} catch (\RuntimeException $e) {
			return new JSONResponse(['error' => $this->appL10n()->t($e->getMessage())], Http::STATUS_BAD_REQUEST);
		}
	}

	#[NoAdminRequired]
	public function importCommit(): JSONResponse {
		$csv = (string)$this->request->getParam('csv', '');
		$collection = $this->request->getParam('collection', []);
		$columns = $this->request->getParam('columns', []);
		if (!is_array($columns) || count($columns) === 0) {
			return new JSONResponse(['error' => 'columns required'], Http::STATUS_BAD_REQUEST);
		}
		try {
			return new JSONResponse($this->service->importCommit(
				$this->uid(), $csv, is_array($collection) ? $collection : [], $columns, $this->appL10n()
			));
		} catch (\RuntimeException $e) {
			return new JSONResponse(['error' => $this->appL10n()->t($e->getMessage())], Http::STATUS_BAD_REQUEST);
		}
	}

	#[NoAdminRequired]
	public function uploadImage(): JSONResponse {
		$dataUrl = (string)$this->request->getParam('dataUrl', '');
		$collectionId = (int)$this->request->getParam('collection_id', 0);
		try {
			$name = $this->l->t('Uncategorized');
			if ($collectionId > 0) {
				$name = (string)($this->service->getCollection($this->uid(), $collectionId)['name'] ?? $this->l->t('Uncategorized'));
			}
			return new JSONResponse(['id' => (string)$this->images->saveDataUrl($this->uid(), $name, $dataUrl)]);
		} catch (DoesNotExistException $e) {
			return $this->notFound();
		} catch (\RuntimeException $e) {
			return new JSONResponse(['error' => $this->appL10n()->t($e->getMessage())], Http::STATUS_BAD_REQUEST);
		}
	}

	#[NoAdminRequired]
	#[NoCSRFRequired]
	public function exportCollection(int $id): DataDownloadResponse|JSONResponse {
		$format = strtolower((string)$this->request->getParam('format', 'csv'));
		if (!in_array($format, ['csv', 'json'], true)) {
			$format = 'csv';
		}
		try {
			$out = $this->service->exportCollection($this->uid(), $id, $format);
			return new DataDownloadResponse($out['content'], $out['filename'], $out['mime']);
		} catch (DoesNotExistException $e) {
			return $this->notFound();
		}
	}

	#[NoAdminRequired]
	public function getSettings(): JSONResponse {
		$uid = $this->uid();
		return new JSONResponse($this->settingsPayload($uid));
	}

	private function settingsPayload(string $uid): array {
		$c = $this->config;
		return [
			'files_folder' => $this->images->getBaseFolder($uid),
			'theme' => $c->getUserValue($uid, Application::APP_ID, 'theme', 'auto'),
			// 'auto' = follow the Nextcloud user language; otherwise a specific bundle code.
			'language' => $c->getUserValue($uid, Application::APP_ID, 'language', 'auto'),
			'languages' => $this->availableLanguages(),
			// client-side encryption metadata (server never sees the key or plaintext)
			'enc_enabled' => $c->getUserValue($uid, Application::APP_ID, 'enc_enabled', '0') === '1',
			'enc_salt' => $c->getUserValue($uid, Application::APP_ID, 'enc_salt', ''),
			'enc_verifier' => $c->getUserValue($uid, Application::APP_ID, 'enc_verifier', ''),
			// External-app availability, so the UI can disable import/export that needs them.
			'apps' => [
				'contacts' => $this->contactsManager->isEnabled(),
				'tables' => $this->tablesBridge->available(),
			],
		];
	}

	/** l10n bundle codes shipped with the app, with human names (endonyms). */
	private function availableLanguages(): array {
		$names = [
			'ja' => '日本語', 'en' => 'English', 'zh' => '简体中文', 'es' => 'Español',
			'fr' => 'Français', 'de' => 'Deutsch', 'ru' => 'Русский', 'pt' => 'Português',
			'ar' => 'العربية', 'hi' => 'हिन्दी', 'ko' => '한국어', 'it' => 'Italiano',
		];
		$out = [];
		foreach (glob(__DIR__ . '/../../l10n/*.json') ?: [] as $path) {
			$code = basename($path, '.json');
			$out[] = ['code' => $code, 'name' => $names[$code] ?? $code];
		}
		return $out;
	}

	private function languageCodes(): array {
		return array_map(static fn (array $l): string => $l['code'], $this->availableLanguages());
	}

	#[NoAdminRequired]
	public function getI18n(string $lang): JSONResponse {
		if (!in_array($lang, $this->languageCodes(), true)) {
			return new JSONResponse(['error' => 'unknown language'], Http::STATUS_NOT_FOUND);
		}
		$path = realpath(__DIR__ . '/../../l10n/' . $lang . '.json');
		$base = realpath(__DIR__ . '/../../l10n');
		if ($path === false || $base === false || strpos($path, $base) !== 0) {
			return $this->notFound();
		}
		$data = json_decode((string)file_get_contents($path), true);
		return new JSONResponse(['translations' => $data['translations'] ?? []]);
	}

	#[NoAdminRequired]
	public function updateSettings(): JSONResponse {
		$uid = $this->uid();
		$params = $this->request->getParams();
		if (array_key_exists('files_folder', $params)) {
			$this->images->setBaseFolder($uid, (string)$params['files_folder']);
		}
		if (array_key_exists('theme', $params)) {
			$theme = (string)$params['theme'];
			if (in_array($theme, self::ALLOWED_THEMES, true)) {
				$this->config->setUserValue($uid, Application::APP_ID, 'theme', $theme);
			}
		}
		if (array_key_exists('language', $params)) {
			$lang = (string)$params['language'];
			if ($lang === 'auto' || in_array($lang, $this->languageCodes(), true)) {
				$this->config->setUserValue($uid, Application::APP_ID, 'language', $lang);
			}
		}
		// Encryption metadata: salt + verifier (ciphertext) + on/off flag. No key material.
		if (array_key_exists('enc_salt', $params)) {
			$this->config->setUserValue($uid, Application::APP_ID, 'enc_salt', (string)$params['enc_salt']);
		}
		if (array_key_exists('enc_verifier', $params)) {
			$this->config->setUserValue($uid, Application::APP_ID, 'enc_verifier', (string)$params['enc_verifier']);
		}
		if (array_key_exists('enc_enabled', $params)) {
			$on = $params['enc_enabled'] === true || $params['enc_enabled'] === '1' || $params['enc_enabled'] === 1;
			$this->config->setUserValue($uid, Application::APP_ID, 'enc_enabled', $on ? '1' : '0');
		}
		return new JSONResponse($this->settingsPayload($uid));
	}

	/**
	 * Download all data (collections, records, settings, attachments) as a
	 * password-protected (AES-256) ZIP. The password must equal the user's
	 * Nextcloud login password and is reused as the archive password.
	 */
	#[NoAdminRequired]
	public function backup(): JSONResponse|DataDownloadResponse {
		$uid = $this->uid();
		$l = $this->appL10n();
		$password = (string)$this->request->getParam('password', '');
		if ($password === '' || $this->userManager->checkPassword($uid, $password) === false) {
			return new JSONResponse(['error' => $l->t('Incorrect password')], Http::STATUS_FORBIDDEN);
		}
		$export = $this->service->exportAll($uid);
		$struct = $export['struct'];

		$attachments = [];
		$files = [];
		foreach ($export['attachmentIds'] as $id) {
			$fc = $this->images->fileContentById($uid, (string)$id);
			if ($fc !== null) {
				$files[(string)$id] = $fc;
				$attachments[] = ['id' => (string)$id, 'name' => $fc['name']];
			}
		}
		$struct['attachments'] = $attachments;
		$struct['settings'] = [
			'files_folder' => $this->images->getBaseFolder($uid),
			'theme' => $this->config->getUserValue($uid, Application::APP_ID, 'theme', 'auto'),
			'language' => $this->config->getUserValue($uid, Application::APP_ID, 'language', 'auto'),
			'enc_enabled' => $this->config->getUserValue($uid, Application::APP_ID, 'enc_enabled', '0'),
			'enc_salt' => $this->config->getUserValue($uid, Application::APP_ID, 'enc_salt', ''),
			'enc_verifier' => $this->config->getUserValue($uid, Application::APP_ID, 'enc_verifier', ''),
		];

		$tmp = $this->tempManager->getTemporaryFile('.zip');
		$zip = new \ZipArchive();
		if ($zip->open($tmp, \ZipArchive::CREATE | \ZipArchive::OVERWRITE) !== true) {
			return new JSONResponse(['error' => $l->t('Failed to create the backup')], Http::STATUS_INTERNAL_SERVER_ERROR);
		}
		$zip->setPassword($password);
		$zip->addFromString('data.json', (string)json_encode($struct, JSON_UNESCAPED_UNICODE | JSON_PRETTY_PRINT));
		$zip->setEncryptionName('data.json', \ZipArchive::EM_AES_256);
		foreach ($files as $id => $fc) {
			$entry = 'files/' . $id;
			$zip->addFromString($entry, $fc['content']);
			$zip->setEncryptionName($entry, \ZipArchive::EM_AES_256);
		}
		$zip->close();
		$content = (string)file_get_contents($tmp);
		@unlink($tmp);

		$safeUid = preg_replace('/[^A-Za-z0-9._-]+/', '_', $uid);
		$fname = 'RegiBase-' . $safeUid . '_' . gmdate('Ymd') . '_backup.zip';
		return new DataDownloadResponse($content, $fname, 'application/zip');
	}

	/**
	 * Restore a backup ZIP. Decrypts with the supplied password (same one used
	 * at creation), then REPLACES all existing RegiBase data with its contents.
	 */
	#[NoAdminRequired]
	public function restore(): JSONResponse {
		$uid = $this->uid();
		$l = $this->appL10n();
		$password = (string)$this->request->getParam('password', '');
		$dataUrl = (string)$this->request->getParam('dataUrl', '');
		$mode = (string)$this->request->getParam('mode', 'overwrite');
		if (!in_array($mode, ['overwrite', 'merge', 'add'], true)) {
			$mode = 'overwrite';
		}
		if ($password === '') {
			return new JSONResponse(['error' => $l->t('Please enter your password')], Http::STATUS_BAD_REQUEST);
		}
		$b64 = $dataUrl;
		if (($p = strpos($b64, 'base64,')) !== false) {
			$b64 = substr($b64, $p + 7);
		}
		$bin = base64_decode($b64, true);
		if ($bin === false || $bin === '') {
			return new JSONResponse(['error' => $l->t('The archive is invalid')], Http::STATUS_BAD_REQUEST);
		}
		$tmp = $this->tempManager->getTemporaryFile('.zip');
		file_put_contents($tmp, $bin);
		$zip = new \ZipArchive();
		if ($zip->open($tmp) !== true) {
			@unlink($tmp);
			return new JSONResponse(['error' => $l->t('Cannot open the archive')], Http::STATUS_BAD_REQUEST);
		}
		$zip->setPassword($password);
		$json = $zip->getFromName('data.json');
		if ($json === false) {
			$zip->close();
			@unlink($tmp);
			return new JSONResponse(['error' => $l->t('Wrong password or corrupted archive')], Http::STATUS_FORBIDDEN);
		}
		$struct = json_decode($json, true);
		if (!is_array($struct) || !isset($struct['collections'])) {
			$zip->close();
			@unlink($tmp);
			return new JSONResponse(['error' => $l->t('The archive contents are invalid')], Http::STATUS_BAD_REQUEST);
		}

		// settings are only restored for a full overwrite; merge/add keep current settings
		if ($mode === 'overwrite' && is_array($struct['settings'] ?? null)) {
			$s = $struct['settings'];
			if (isset($s['files_folder'])) {
				$this->images->setBaseFolder($uid, (string)$s['files_folder']);
			}
			foreach (['theme', 'language', 'enc_enabled', 'enc_salt', 'enc_verifier'] as $k) {
				if (array_key_exists($k, $s)) {
					$this->config->setUserValue($uid, Application::APP_ID, $k, (string)$s[$k]);
				}
			}
		}

		// re-save attachments, mapping old fileId → new fileId
		$fileIdMap = [];
		foreach (($struct['attachments'] ?? []) as $att) {
			$oid = (string)($att['id'] ?? '');
			if ($oid === '') {
				continue;
			}
			$fileContent = $zip->getFromName('files/' . $oid);
			if ($fileContent === false) {
				continue;
			}
			try {
				$fileIdMap[$oid] = (string)$this->images->saveRaw($uid, (string)($att['name'] ?? 'file'), $fileContent);
			} catch (\Throwable $e) {
				/* skip an unrestorable attachment rather than abort the whole restore */
			}
		}
		$zip->close();
		@unlink($tmp);

		$result = $this->service->importAll($uid, $struct, $fileIdMap, $mode);
		return new JSONResponse($result);
	}

	#[NoAdminRequired]
	public function uploadFile(): JSONResponse {
		$name = (string)$this->request->getParam('name', '');
		$collectionId = (int)$this->request->getParam('collection_id', 0);
		$dataUrl = (string)$this->request->getParam('dataUrl', '');
		$base64 = (string)$this->request->getParam('data', '');
		if ($base64 === '' && $dataUrl !== '' && ($p = strpos($dataUrl, 'base64,')) !== false) {
			$base64 = substr($dataUrl, $p + 7);
		}
		try {
			$collName = 'Uncategorized';
			if ($collectionId > 0) {
				$collName = (string)($this->service->getCollection($this->uid(), $collectionId)['name'] ?? 'Uncategorized');
			}
			$out = $this->images->saveDocument($this->uid(), $collName, $name, $base64);
			return new JSONResponse(['id' => (string)$out['id'], 'name' => $out['name']]);
		} catch (DoesNotExistException $e) {
			return $this->notFound();
		} catch (\RuntimeException $e) {
			return new JSONResponse(['error' => $this->appL10n()->t($e->getMessage())], Http::STATUS_BAD_REQUEST);
		}
	}

	#[NoAdminRequired]
	public function browseFiles(): JSONResponse {
		$path = (string)$this->request->getParam('path', '');
		$listing = $this->images->browse($this->uid(), $path);
		if ($listing === null) {
			return new JSONResponse(['error' => $this->l->t('Cannot open the folder')], Http::STATUS_NOT_FOUND);
		}
		return new JSONResponse($listing);
	}

	#[NoAdminRequired]
	public function resolveFilePath(): JSONResponse {
		$path = (string)$this->request->getParam('path', '');
		$meta = $this->images->resolveByPath($this->uid(), $path);
		if ($meta === null) {
			return new JSONResponse(['error' => $this->l->t('File not found')], Http::STATUS_NOT_FOUND);
		}
		return new JSONResponse($meta);
	}

	#[NoAdminRequired]
	public function fileMeta(string $id): JSONResponse {
		$meta = $this->images->fileMeta($this->uid(), $id);
		if ($meta === null) {
			return $this->notFound();
		}
		return new JSONResponse($meta);
	}

	#[NoAdminRequired]
	#[NoCSRFRequired]
	public function getFile(string $id): DataDownloadResponse|JSONResponse {
		$f = $this->images->resolveFile($this->uid(), $id);
		if ($f === null) {
			return new JSONResponse(['error' => 'not found'], Http::STATUS_NOT_FOUND);
		}
		return new DataDownloadResponse($f['content'], $f['name'], $f['mime']);
	}

	#[NoAdminRequired]
	#[NoCSRFRequired]
	public function getImage(string $id): DataDisplayResponse {
		$img = $this->images->resolve($this->uid(), $id);
		if ($img === null) {
			return new DataDisplayResponse('', Http::STATUS_NOT_FOUND);
		}
		$resp = new DataDisplayResponse($img['content'], Http::STATUS_OK, ['Content-Type' => $img['mime']]);
		$resp->cacheFor(3600, false, true);
		return $resp;
	}

	// ---- internal sharing ----

	/** Display name for a uid, falling back to the uid itself. */
	private function displayName(string $uid): string {
		$u = $this->userManager->get($uid);
		return $u ? $u->getDisplayName() : $uid;
	}

	/** Search users to share with (by uid or display name), excluding self. */
	#[NoAdminRequired]
	public function searchUsers(): JSONResponse {
		$q = trim((string)$this->request->getParam('q', ''));
		$me = $this->uid();
		if (mb_strlen($q) < 1) {
			return new JSONResponse(['users' => []]);
		}
		$found = [];
		foreach ($this->userManager->searchDisplayName($q, 25) as $u) {
			$found[$u->getUID()] = $u->getDisplayName();
		}
		foreach ($this->userManager->search($q, 25) as $u) {
			$found[$u->getUID()] = $u->getDisplayName();
		}
		$users = [];
		foreach ($found as $uid => $name) {
			if ($uid === $me) {
				continue;
			}
			$users[] = ['uid' => $uid, 'name' => $name];
			if (count($users) >= 20) {
				break;
			}
		}
		return new JSONResponse(['users' => $users]);
	}

	/** List a collection's shares (owner only). */
	#[NoAdminRequired]
	public function collectionShares(int $id): JSONResponse {
		try {
			$shares = $this->service->listShares($this->uid(), $id);
		} catch (DoesNotExistException $e) {
			return $this->notFound();
		}
		foreach ($shares as &$s) {
			$s['recipient_name'] = $this->displayName((string)$s['recipient_uid']);
		}
		return new JSONResponse(['shares' => $shares]);
	}

	/** Share a collection with a user (owner only). */
	#[NoAdminRequired]
	public function addShare(int $id): JSONResponse {
		$recipient = trim((string)$this->request->getParam('recipient', ''));
		$perm = (string)$this->request->getParam('perm', 'view');
		$password = $this->request->getParam('password');
		$encKey = $this->request->getParam('enc_key');
		$encSalt = $this->request->getParam('enc_salt');
		$l = $this->appL10n();
		if ($recipient === '' || $this->userManager->get($recipient) === null) {
			return new JSONResponse(['error' => $l->t('No such user')], Http::STATUS_BAD_REQUEST);
		}
		try {
			$s = $this->service->addShare($this->uid(), $id, $recipient,
				$perm,
				is_string($password) ? $password : null,
				is_string($encKey) ? $encKey : null,
				is_string($encSalt) ? $encSalt : null);
			$s['recipient_name'] = $this->displayName($recipient);
			return new JSONResponse($s, Http::STATUS_CREATED);
		} catch (DoesNotExistException $e) {
			return $this->notFound();
		} catch (\RuntimeException $e) {
			return new JSONResponse(['error' => $l->t($e->getMessage())], Http::STATUS_BAD_REQUEST);
		}
	}

	/** Update a share (owner only). */
	#[NoAdminRequired]
	public function updateShare(int $id, string $uid): JSONResponse {
		$patch = [];
		foreach (['perm', 'password', 'enc_key', 'enc_salt'] as $k) {
			if ($this->request->getParam($k) !== null) {
				$patch[$k] = $this->request->getParam($k);
			}
		}
		try {
			$s = $this->service->updateShare($this->uid(), $id, $uid, $patch);
			$s['recipient_name'] = $this->displayName($uid);
			return new JSONResponse($s);
		} catch (DoesNotExistException $e) {
			return $this->notFound();
		}
	}

	/** Remove a share (owner only). */
	#[NoAdminRequired]
	public function removeShare(int $id, string $uid): JSONResponse {
		try {
			$this->service->removeShare($this->uid(), $id, $uid);
			return new JSONResponse(['ok' => true]);
		} catch (DoesNotExistException $e) {
			return $this->notFound();
		}
	}

	/** Recipient unlocks a shared collection (verify share password, get wrapped key). */
	#[NoAdminRequired]
	public function unlockShare(int $id): JSONResponse {
		$password = (string)$this->request->getParam('password', '');
		try {
			return new JSONResponse($this->service->unlockShare($this->uid(), $id, $password));
		} catch (ForbiddenException $e) {
			return new JSONResponse(['error' => $this->appL10n()->t('Incorrect share password')], Http::STATUS_FORBIDDEN);
		} catch (DoesNotExistException $e) {
			return $this->notFound();
		}
	}
}
