<?php

declare(strict_types=1);

namespace OCA\RegiBase\Controller;

use OCA\RegiBase\AppInfo\Application;
use OCA\RegiBase\Service\ContactsImport;
use OCA\RegiBase\Service\DataImport;
use OCA\RegiBase\Service\ImageService;
use OCA\RegiBase\Service\RegiBaseService;
use OCA\RegiBase\Service\Templates;
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
			return new JSONResponse(['error' => $l->t('連絡先アプリが有効ではありません')], Http::STATUS_BAD_REQUEST);
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
			$name = $l->t('連絡先');
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

	#[NoAdminRequired]
	public function templates(): JSONResponse {
		return new JSONResponse(Templates::all($this->appL10n()));
	}

	#[NoAdminRequired]
	public function collections(): JSONResponse {
		return new JSONResponse($this->service->listCollections($this->uid()));
	}

	#[NoAdminRequired]
	public function getCollection(int $id): JSONResponse {
		try {
			return new JSONResponse($this->service->getCollection($this->uid(), $id));
		} catch (DoesNotExistException $e) {
			return $this->notFound();
		}
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
		} catch (DoesNotExistException $e) {
			return $this->notFound();
		}
	}

	#[NoAdminRequired]
	public function createRecord(int $id): JSONResponse {
		try {
			$data = $this->request->getParam('data', []);
			return new JSONResponse($this->service->createRecord($this->uid(), $id, is_array($data) ? $data : []), Http::STATUS_CREATED);
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
		} catch (DoesNotExistException $e) {
			return $this->notFound();
		}
	}

	#[NoAdminRequired]
	public function deleteRecord(int $id): JSONResponse {
		try {
			$this->service->deleteRecord($this->uid(), $id);
			return new JSONResponse(['ok' => true]);
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
			$name = $this->l->t('未分類');
			if ($collectionId > 0) {
				$name = (string)($this->service->getCollection($this->uid(), $collectionId)['name'] ?? $this->l->t('未分類'));
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
			return new JSONResponse(['error' => $l->t('パスワードが違います')], Http::STATUS_FORBIDDEN);
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
			return new JSONResponse(['error' => $l->t('バックアップの作成に失敗しました')], Http::STATUS_INTERNAL_SERVER_ERROR);
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
			return new JSONResponse(['error' => $l->t('パスワードを入力してください')], Http::STATUS_BAD_REQUEST);
		}
		$b64 = $dataUrl;
		if (($p = strpos($b64, 'base64,')) !== false) {
			$b64 = substr($b64, $p + 7);
		}
		$bin = base64_decode($b64, true);
		if ($bin === false || $bin === '') {
			return new JSONResponse(['error' => $l->t('アーカイブが不正です')], Http::STATUS_BAD_REQUEST);
		}
		$tmp = $this->tempManager->getTemporaryFile('.zip');
		file_put_contents($tmp, $bin);
		$zip = new \ZipArchive();
		if ($zip->open($tmp) !== true) {
			@unlink($tmp);
			return new JSONResponse(['error' => $l->t('アーカイブを開けません')], Http::STATUS_BAD_REQUEST);
		}
		$zip->setPassword($password);
		$json = $zip->getFromName('data.json');
		if ($json === false) {
			$zip->close();
			@unlink($tmp);
			return new JSONResponse(['error' => $l->t('パスワードが違うか、アーカイブが壊れています')], Http::STATUS_FORBIDDEN);
		}
		$struct = json_decode($json, true);
		if (!is_array($struct) || !isset($struct['collections'])) {
			$zip->close();
			@unlink($tmp);
			return new JSONResponse(['error' => $l->t('アーカイブの内容が不正です')], Http::STATUS_BAD_REQUEST);
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
			$collName = '未分類';
			if ($collectionId > 0) {
				$collName = (string)($this->service->getCollection($this->uid(), $collectionId)['name'] ?? '未分類');
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
			return new JSONResponse(['error' => $this->l->t('フォルダを開けません')], Http::STATUS_NOT_FOUND);
		}
		return new JSONResponse($listing);
	}

	#[NoAdminRequired]
	public function resolveFilePath(): JSONResponse {
		$path = (string)$this->request->getParam('path', '');
		$meta = $this->images->resolveByPath($this->uid(), $path);
		if ($meta === null) {
			return new JSONResponse(['error' => $this->l->t('ファイルが見つかりません')], Http::STATUS_NOT_FOUND);
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
}
