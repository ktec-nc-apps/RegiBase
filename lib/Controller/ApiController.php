<?php

declare(strict_types=1);

namespace OCA\RegiBase\Controller;

use OCA\RegiBase\AppInfo\Application;
use OCA\RegiBase\Service\BadRegexException;
use OCA\RegiBase\Service\ContactsImport;
use OCA\RegiBase\Service\DataImport;
use OCA\RegiBase\Service\ForbiddenException;
use OCA\RegiBase\Service\LockedException;
use OCA\RegiBase\Service\ImageService;
use OCA\RegiBase\Service\RegiBaseService;
use OCA\RegiBase\Service\TablesBridge;
use OCA\RegiBase\Service\TemplateService;
use OCP\Contacts\IManager as IContactsManager;
use OCP\App\IAppManager;
use OCP\AppFramework\Controller;
use OCP\AppFramework\Db\DoesNotExistException;
use OCP\AppFramework\Http;
use OCP\AppFramework\Http\Attribute\BruteForceProtection;
use OCP\AppFramework\Http\Attribute\NoAdminRequired;
use OCP\AppFramework\Http\Attribute\NoCSRFRequired;
use OCP\AppFramework\Http\DataDisplayResponse;
use OCP\AppFramework\Http\DataDownloadResponse;
use OCP\AppFramework\Http\JSONResponse;
use OCP\AppFramework\Http\StreamResponse;
use OCP\Collaboration\Collaborators\ISearch;
use OCP\IConfig;
use OCP\IGroupManager;
use OCP\IL10N;
use OCP\IRequest;
use OCP\ITempManager;
use OCP\IUserManager;
use OCP\IUserSession;
use OCP\L10N\IFactory;
use OCP\Share\IManager as IShareManager;
use OCP\Share\IShare;

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
		private IGroupManager $groupManager,
		private ITempManager $tempManager,
		private IContactsManager $contactsManager,
		private TablesBridge $tablesBridge,
		private TemplateService $tplService,
		private IAppManager $appManager,
		private ISearch $collaboratorSearch,
		private IShareManager $shareManager,
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
		// The DAV app's CardDavBackend is not public API. It is fetched only here, when a photo
		// is read: injected into the controller, a change to it stopped every RegiBase request
		// (review P20). Without it the contacts come in without their photos.
		try {
			if (!class_exists(\OCA\DAV\CardDAV\CardDavBackend::class)) {
				return null;
			}
			$card = \OCP\Server::get(\OCA\DAV\CardDAV\CardDavBackend::class)->getCard($addressBookId, $cardUri);
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
		$icon = trim((string)$this->request->getParam('icon', ''));

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
			'icon' => $icon !== '' ? $icon : '👤',
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
			return new JSONResponse(['available' => true, 'tables' => [], 'error' => $this->failure($e)->getData()['error']]);
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
		$icon = trim((string)$this->request->getParam('icon', ''));
		try {
			$payload = $this->tablesBridge->buildImport($uid, $tableId);
		} catch (\Throwable $e) {
			return $this->failure($e);
		}
		if ($name !== '') {
			$payload['name'] = $name;
		}
		if ($icon !== '') {
			$payload['icon'] = $icon;
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
			return $this->failure($e);
		}
	}

	/**
	 * IL10N for the user's RegiBase language setting ('auto' = follow Nextcloud).
	 * Used so built-in templates match the in-app language, not just the NC language.
	 */
	private function appL10n(): IL10N {
		$lang = $this->userLanguage($this->uid());
		if ($lang !== 'auto' && in_array($lang, $this->languageCodes(), true)) {
			return $this->l10nFactory->get(Application::APP_ID, $lang);
		}
		return $this->l;
	}

	/**
	 * Every secret-field value the user owns, hidden collections included; never a
	 * collection shared in by somebody else (that is under their key, not ours).
	 *
	 * Master key change and removal used to walk GET collections, which leaves the
	 * hidden collections out (their values stayed under the old key, and the old salt
	 * was gone) and puts shared-in ones in (their values do not open with our key, so
	 * the change always stopped half way). Review K1, K2.
	 */
	#[NoAdminRequired]
	public function ownedSecrets(): JSONResponse {
		$uid = $this->uid();
		$items = [];
		$sweep = \OCP\Server::get(\OCA\RegiBase\Service\SecretSweep::class);
		foreach ($sweep->ownedKeys($uid) as $cid => $keys) {
			foreach (\OCP\Server::get(\OCA\RegiBase\Db\RecordMapper::class)->findForCollection($cid) as $r) {
				$data = json_decode($r->getData() ?: '{}', true);
				if (!is_array($data)) {
					continue;
				}
				// secret fields, and ciphertext left in a field that is no longer secret (review P9)
				$out = \OCA\RegiBase\Service\SecretSweep::pick($data, $keys);
				if ($out) {
					$items[] = ['id' => (int)$r->getId(), 'collection' => $cid, 'data' => $out];
				}
			}
		}
		$wraps = [];
		foreach (\OCP\Server::get(\OCA\RegiBase\Db\CollectionMapper::class)->findAllForUser($uid) as $c) {
			if (($c->getKeyWrap() ?? '') !== '') {
				$wraps[(string)$c->getId()] = $c->getKeyWrap();
			}
		}
		// versions and undo history hold secret values too (review P9, K12); a deleted
		// collection's own key kept in the history is listed under "h<history id>"
		$extra = $sweep->collect($uid);
		foreach ($extra['wraps'] as $ref => $w) {
			$wraps[$ref] = $w;
		}
		// wraps: collection id -> its own key, wrapped with the master key (values in it are under that key)
		return new JSONResponse(['items' => $items, 'vers' => $extra['vers'], 'hist' => $extra['hist'], 'wraps' => (object)$wraps]);
	}

	/**
	 * Write the re-keyed secret values and the key settings together, or none of them.
	 * The client works every value out first and sends it all at once; a change that
	 * stopped half way left records under a new key whose salt was never saved, and
	 * those secrets could not be read again (review K1).
	 * Body: { items: [{ id, data: { key: value } }], settings: { enc_enabled?, enc_salt?, enc_verifier?, clear? } }
	 */
	#[NoAdminRequired]
	public function rekeySecrets(): JSONResponse {
		$uid = $this->uid();
		$items = $this->request->getParam('items');
		$settings = $this->request->getParam('settings');
		if (!is_array($items) || !is_array($settings)) {
			return new JSONResponse(['error' => 'Bad request'], Http::STATUS_BAD_REQUEST);
		}
		// The values were read under the key the page knew; if the key changed since (another tab,
		// another device), writing them would mix two keys (review, second look).
		$expect = $this->request->getParam('expect_verifier');
		if (is_string($expect) && $expect !== $this->config->getUserValue($uid, Application::APP_ID, 'enc_verifier', '')) {
			return new JSONResponse(['error' => $this->appL10n()->t('Please reload the page and try again.'), 'code' => 'conflict'], Http::STATUS_CONFLICT);
		}
		$sweep = \OCP\Server::get(\OCA\RegiBase\Service\SecretSweep::class);
		$map = $sweep->ownedKeys($uid);
		$records = \OCP\Server::get(\OCA\RegiBase\Db\RecordMapper::class);
		$work = [];
		foreach ($items as $it) {
			$id = (int)($it['id'] ?? 0);
			$data = $it['data'] ?? null;
			if ($id <= 0 || !is_array($data)) {
				return new JSONResponse(['error' => 'Bad request'], Http::STATUS_BAD_REQUEST);
			}
			try {
				$r = $records->find($id);
			} catch (\Throwable $e) {
				return new JSONResponse(['error' => 'Not found: ' . $id], Http::STATUS_NOT_FOUND);
			}
			$cid = (int)$r->getCollectionId();
			if (!isset($map[$cid])) {
				return new JSONResponse(['error' => 'Forbidden'], Http::STATUS_FORBIDDEN);
			}
			$cur = json_decode($r->getData() ?: '{}', true);
			if (!is_array($cur)) {
				$cur = [];
			}
			foreach ($data as $k => $v) {
				// Only the secret fields of the user's own collections are touched (or ciphertext
				// left in a field that is no longer secret).
				if (!is_string($v) || !\OCA\RegiBase\Service\SecretSweep::mayWrite($cur, (string)$k, $map[$cid])) {
					return new JSONResponse(['error' => 'Bad field: ' . $k], Http::STATUS_BAD_REQUEST);
				}
				if ($v === '') {
					unset($cur[$k]);
				} else {
					$cur[$k] = $v;
				}
			}
			$work[] = [$r, json_encode($cur, JSON_UNESCAPED_UNICODE)];
		}
		// the same values in the versions and the undo history
		$histWraps = [];
		foreach ((is_array($settings['coll_wraps'] ?? null) ? $settings['coll_wraps'] : []) as $ref => $w) {
			if (str_starts_with((string)$ref, 'h')) {
				$histWraps[(string)$ref] = $w;
				unset($settings['coll_wraps'][$ref]);
			}
		}
		$vers = $this->request->getParam('vers');
		$hist = $this->request->getParam('hist');
		try {
			$extra = $sweep->plan($uid, is_array($vers) ? $vers : [], is_array($hist) ? $hist : [], $histWraps);
		} catch (\InvalidArgumentException $e) {
			return new JSONResponse(['error' => $e->getMessage()], Http::STATUS_BAD_REQUEST);
		}
		$db = \OCP\Server::get(\OCP\IDBConnection::class);
		$app = Application::APP_ID;
		$db->beginTransaction();
		try {
			foreach ($work as [$r, $json]) {
				$r->setData($json);
				$records->update($r);
			}
			$sweep->write($extra);
			// a collection's own key, (re)wrapped with the master key, or taken away (null)
			if (isset($settings['coll_wraps']) && is_array($settings['coll_wraps'])) {
				$cm = \OCP\Server::get(\OCA\RegiBase\Db\CollectionMapper::class);
				foreach ($settings['coll_wraps'] as $cid => $wrap) {
					$ce = $cm->findForUser((int)$cid, $uid);
					$ce->setKeyWrap(($wrap === null || $wrap === '') ? null : (string)$wrap);
					$cm->update($ce);
					if ($wrap === null || $wrap === '') {
						// no key of its own any more: the shares' wrapped copies of it go too
						foreach (\OCP\Server::get(\OCA\RegiBase\Db\ShareMapper::class)->findForCollection((int)$cid) as $sh) {
							$sh->setEncKey(null);
							$sh->setEncSalt(null);
							\OCP\Server::get(\OCA\RegiBase\Db\ShareMapper::class)->update($sh);
						}
					}
				}
			}
			if (!empty($settings['clear'])) {
				$this->config->deleteUserValue($uid, $app, 'enc_enabled');
				$this->config->deleteUserValue($uid, $app, 'enc_salt');
				$this->config->deleteUserValue($uid, $app, 'enc_verifier');
				$this->config->deleteUserValue($uid, $app, 'enc_kdf_iter');
			} else {
				foreach (['enc_salt', 'enc_verifier', 'enc_kdf_iter'] as $k) {
					if (array_key_exists($k, $settings) && self::encValueOk($k, $settings[$k])) {
						$this->config->setUserValue($uid, $app, $k, (string)$settings[$k]);
					}
				}
				// A page from before the rounds were kept (still open in a browser) makes a new key
				// with 250000 and does not say so; the stored count must follow, or the key
				// would not open again (review K17).
				if (array_key_exists('enc_salt', $settings) && !array_key_exists('enc_kdf_iter', $settings)) {
					$this->config->setUserValue($uid, $app, 'enc_kdf_iter', (string)\OCA\RegiBase\Service\Kdf::LEGACY);
				}
				if (array_key_exists('enc_enabled', $settings)) {
					$this->config->setUserValue($uid, $app, 'enc_enabled', $settings['enc_enabled'] ? '1' : '0');
				}
			}
			$db->commit();
		} catch (\Throwable $e) {
			$db->rollBack();
			return $this->failure($e, Http::STATUS_INTERNAL_SERVER_ERROR);
		}
		return new JSONResponse(['ok' => true, 'records' => count($work)]);
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

	/**
	 * The answer for an exception caught in a controller. RegiBase's own messages are shown,
	 * translated; anything else (the Tables app's inner errors, a database error) is logged
	 * and answered with a plain "Operation failed": its text, class names and all, used to
	 * go to the page as it was (review P15).
	 */
	private function failure(\Throwable $e, int $status = Http::STATUS_BAD_REQUEST): JSONResponse {
		$cls = get_class($e);
		if (in_array($cls, [\RuntimeException::class, \InvalidArgumentException::class], true) || str_starts_with($cls, 'OCA\\RegiBase\\')) {
			return new JSONResponse(['error' => $this->appL10n()->t($e->getMessage())], $status);
		}
		// The class and the message only. With the exception itself the log took its stack
		// trace, arguments and all, and those can hold record data (review).
		\OCP\Server::get(\Psr\Log\LoggerInterface::class)->error('RegiBase: ' . $cls . ': ' . $e->getMessage() . ' (' . basename($e->getFile()) . ':' . $e->getLine() . ')', ['app' => Application::APP_ID]);
		return new JSONResponse(['error' => $this->appL10n()->t('Operation failed')], $status);
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
			return $this->failure($e);
		}
	}

	#[NoAdminRequired]
	public function updateTemplate(int $id): JSONResponse {
		try {
			return new JSONResponse($this->tplService->update($this->uid(), $id, $this->request->getParams()));
		} catch (DoesNotExistException $e) {
			return $this->notFound();
		} catch (\Throwable $e) {
			return $this->failure($e);
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
			return $this->failure($e);
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
			return $this->failure($e);
		}
	}

	#[NoAdminRequired]
	public function collections(): JSONResponse {
		// Reading the list changes nothing: it used to create every collection's save folder,
		// so a folder deleted in Files came back each time RegiBase was opened (review P18).
		// A folder is made when the collection is made and when something is saved into it.
		return new JSONResponse($this->service->listCollections($this->uid()));
	}

	#[NoAdminRequired]
	public function getCollection(int $id): JSONResponse {
		try {
			// no folder is made by reading (review P18)
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
		// If the new collection's save folder would collide with another
		// collection's, ask the client first (unless it already chose). Returns a
		// non-creating signal the frontend turns into a Yes/No prompt.
		if ((string)($body['folder_choice'] ?? '') === '') {
			$conflict = $this->service->collectionFolderConflict($this->uid(), $body, $this->appL10n());
			if ($conflict !== null) {
				return new JSONResponse(['folder_conflict' => true, 'folder' => $conflict]);
			}
		}
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
		} catch (\InvalidArgumentException $e) {
			return new JSONResponse(['error' => $e->getMessage()], Http::STATUS_BAD_REQUEST);
		}
	}

	/**
	 * Reveal the caller's own secret collections whose 6-digit key matches.
	 * Returns the matching collections (possibly empty); the client shows them
	 * for the session only.
	 */
	// Nextcloud's brute-force throttle: a wrong key slows the next try down, so the
	// 10^6 six-digit keys cannot simply be walked through (review P5).
	#[NoAdminRequired]
	#[BruteForceProtection(action: 'regibase_secret_pin')]
	public function revealSecretCollections(): JSONResponse {
		$pin = (string)($this->request->getParam('pin') ?? '');
		$found = $this->service->revealSecretCollections($this->uid(), $pin);
		$res = new JSONResponse($found);
		if (!$found) {
			$res->throttle(['uid' => $this->uid()]);
		}
		return $res;
	}

	#[NoAdminRequired]
	public function deleteCollection(int $id): JSONResponse {
		try {
			$deleteFolder = filter_var($this->request->getParam('delete_folder', false), FILTER_VALIDATE_BOOLEAN);
			$this->service->deleteCollection($this->uid(), $id, $deleteFolder);
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
	public function putFields(int $id): JSONResponse {
		$fields = $this->request->getParam('fields');
		if (!is_array($fields)) {
			return new JSONResponse(['error' => 'fields[] required'], Http::STATUS_BAD_REQUEST);
		}
		$grp = $this->request->getParam('_undoGroup');
		try {
			return new JSONResponse($this->service->replaceFields($this->uid(), $id, $fields, is_string($grp) ? $grp : null));
		} catch (LockedException $e) {
			return $this->locked();
		} catch (ForbiddenException $e) {
			return $this->forbidden();
		} catch (DoesNotExistException $e) {
			return $this->notFound();
		}
	}

	#[NoAdminRequired]
	public function records(int $id): JSONResponse {
		try {
			$q = $this->request->getParam('q');
			$sort = $this->request->getParam('sort');
			$regex = in_array($this->request->getParam('regex'), ['1', 'true', true], true);
			return new JSONResponse($this->service->listRecords($this->uid(), $id, $q, $sort, $regex));
		} catch (BadRegexException $e) {
			return new JSONResponse(['error' => $this->appL10n()->t($e->getMessage()), 'code' => 'bad_regex'], Http::STATUS_BAD_REQUEST);
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
		} catch (\RuntimeException $e) {
			return new JSONResponse(['error' => $this->appL10n()->t($e->getMessage())], Http::STATUS_BAD_REQUEST);
		}
	}

	#[NoAdminRequired]
	public function getRecord(int $id): JSONResponse {
		try {
			return new JSONResponse($this->service->getRecord($this->uid(), $id));
		} catch (LockedException $e) {
			return $this->locked();
		} catch (ForbiddenException $e) {
			return $this->forbidden();
		} catch (DoesNotExistException $e) {
			return $this->notFound();
		}
	}

	#[NoAdminRequired]
	public function updateRecord(int $id): JSONResponse {
		try {
			$data = $this->request->getParam('data', []);
			$grp = $this->request->getParam('_undoGroup');
			$noHistory = in_array($this->request->getParam('_noHistory'), ['1', 'true', true], true);
			$manualVersion = in_array($this->request->getParam('_manualVersion'), ['1', 'true', true], true);
			$base = $this->request->getParam('_base');
			return new JSONResponse($this->service->updateRecord($this->uid(), $id, is_array($data) ? $data : [], is_string($grp) ? $grp : null, $noHistory, $manualVersion, is_string($base) ? $base : null));
		} catch (\OCA\RegiBase\Service\ConflictException $e) {
			return new JSONResponse(['error' => $this->appL10n()->t('Somebody else saved this record after you opened it.'), 'code' => 'conflict'], Http::STATUS_CONFLICT);
		} catch (LockedException $e) {
			return $this->locked();
		} catch (ForbiddenException $e) {
			return $this->forbidden();
		} catch (DoesNotExistException $e) {
			return $this->notFound();
		} catch (\RuntimeException $e) {
			return new JSONResponse(['error' => $this->appL10n()->t($e->getMessage())], Http::STATUS_BAD_REQUEST);
		}
	}

	/** Bulk-update many records of one collection in a single request (find & replace). */
	#[NoAdminRequired]
	public function bulkUpdateRecords(int $id): JSONResponse {
		$updates = $this->request->getParam('updates', []);
		$grp = $this->request->getParam('_undoGroup');
		if (!is_array($updates)) {
			$updates = [];
		}
		try {
			return new JSONResponse($this->service->bulkUpdateRecords($this->uid(), $id, $updates, is_string($grp) ? $grp : null));
		} catch (LockedException $e) {
			return $this->locked();
		} catch (ForbiddenException $e) {
			return $this->forbidden();
		} catch (DoesNotExistException $e) {
			return $this->notFound();
		} catch (\RuntimeException $e) {
			return new JSONResponse(['error' => $this->appL10n()->t($e->getMessage())], Http::STATUS_BAD_REQUEST);
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

	// ---- per-record version history ----

	#[NoAdminRequired]
	public function recordVersions(int $id): JSONResponse {
		try {
			return new JSONResponse(['versions' => $this->service->recordVersions($this->uid(), $id)]);
		} catch (ForbiddenException $e) {
			return $this->forbidden();
		} catch (DoesNotExistException $e) {
			return $this->notFound();
		}
	}

	#[NoAdminRequired]
	public function readRecordVersion(int $id, int $number): JSONResponse {
		try {
			return new JSONResponse(['data' => $this->service->readRecordVersion($this->uid(), $id, $number)]);
		} catch (ForbiddenException $e) {
			return $this->forbidden();
		} catch (DoesNotExistException $e) {
			return $this->notFound();
		}
	}

	#[NoAdminRequired]
	public function restoreRecordVersion(int $id): JSONResponse {
		$number = (int)($this->request->getParam('number') ?? 0);
		try {
			return new JSONResponse($this->service->restoreRecordVersion($this->uid(), $id, $number));
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

	// ---- undo / change history ----

	#[NoAdminRequired]
	public function history(): JSONResponse {
		$cid = $this->request->getParam('collection');
		$cid = ($cid !== null && $cid !== '') ? (int)$cid : null;
		return new JSONResponse(['entries' => $this->service->history($this->uid(), $cid)]);
	}

	#[NoAdminRequired]
	public function sessionVersions(int $id): JSONResponse {
		try {
			return new JSONResponse(['versions' => $this->service->sessionVersions($this->uid(), $id)]);
		} catch (DoesNotExistException $e) {
			return $this->notFound();
		}
	}

	#[NoAdminRequired]
	public function restoreSessionVersion(int $id, int $vid): JSONResponse {
		try {
			return new JSONResponse($this->service->restoreSessionVersion($this->uid(), $id, $vid));
		} catch (LockedException $e) {
			return $this->locked();
		} catch (ForbiddenException $e) {
			return $this->forbidden();
		} catch (DoesNotExistException $e) {
			return $this->notFound();
		}
	}

	#[NoAdminRequired]
	public function undo(): JSONResponse {
		$cid = $this->request->getParam('collection');
		$cid = ($cid !== null && $cid !== '') ? (int)$cid : null;
		$downTo = $this->request->getParam('downTo');
		if ($downTo !== null && $downTo !== '' && $cid !== null) {
			return new JSONResponse($this->service->undoDownTo($this->uid(), $cid, (int)$downTo));
		}
		return new JSONResponse($this->service->undo($this->uid(), $cid));
	}

	#[NoAdminRequired]
	public function clearHistory(): JSONResponse {
		$cid = $this->request->getParam('collection');
		$cid = ($cid !== null && $cid !== '') ? (int)$cid : null;
		$this->service->clearHistory($this->uid(), $cid);
		return new JSONResponse(['ok' => true]);
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
			$folder = $this->attachmentFolder($collectionId);
			return new JSONResponse(['id' => (string)$this->images->saveDataUrl($this->uid(), $folder, $dataUrl)]);
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
		} catch (LockedException $e) {
			return $this->locked();
		} catch (ForbiddenException $e) {
			return $this->forbidden();
		} catch (DoesNotExistException $e) {
			return $this->notFound();
		}
	}

	#[NoAdminRequired]
	public function getSettings(): JSONResponse {
		$uid = $this->uid();
		return new JSONResponse($this->settingsPayload($uid) + ['device_tag' => $this->deviceTag()]);
	}

	/**
	 * A random tag that lives as long as this Nextcloud login. A master key remembered on the
	 * device is stored with it, and is not used once the tag differs: after signing out of
	 * Nextcloud, the key has to be entered again (review K9).
	 */
	private function deviceTag(): string {
		$session = \OCP\Server::get(\OCP\ISession::class);
		$tag = $session->get('regibase_device_tag');
		if (!is_string($tag) || $tag === '') {
			$tag = bin2hex(random_bytes(16));
			$session->set('regibase_device_tag', $tag);
		}
		return $tag;
	}

	private function settingsPayload(string $uid): array {
		$c = $this->config;
		return [
			'files_folder' => $this->images->getBaseFolder($uid),
			'theme' => $c->getUserValue($uid, Application::APP_ID, 'theme', 'auto'),
			// 'auto' = follow the Nextcloud user language; otherwise a specific bundle code.
			'language' => $this->userLanguage($uid),
			'languages' => $this->availableLanguages(),
			// Map service used by the 🗺 link on address fields.
			'map_provider' => $c->getUserValue($uid, Application::APP_ID, 'map_provider', 'google'),
			// Undo / change-history depth (max entries kept; 0 disables).
			'undo_limit' => $this->service->undoLimit($uid),
			// How many versions of a record are kept beside it, and when one is
			// taken: every edit, or only the ones the writer asks for.
			'version_keep' => $this->service->versionKeep($uid),
			'version_when' => $this->service->versionWhen($uid),
			// Width of the AI assistant's column ("500px" or "30%").
			'ai_width' => $c->getUserValue($uid, Application::APP_ID, 'ai_width', '500px'),
			// client-side encryption metadata (server never sees the key or plaintext)
			'enc_enabled' => $c->getUserValue($uid, Application::APP_ID, 'enc_enabled', '0') === '1',
			'enc_salt' => $c->getUserValue($uid, Application::APP_ID, 'enc_salt', ''),
			'enc_verifier' => $c->getUserValue($uid, Application::APP_ID, 'enc_verifier', ''),
			// PBKDF2 rounds the master key was made with: 250000 for a key from before (review K17)
			'enc_kdf_iter' => \OCA\RegiBase\Service\Kdf::iterFor($c, $uid),
			// External-app availability, so the UI can disable import/export that needs them.
			'apps' => [
				'contacts' => $this->contactsManager->isEnabled(),
				'tables' => $this->tablesBridge->available(),
				'calendar' => $this->appManager->isEnabledForUser('calendar'),
			],
		];
	}

	/** l10n bundle codes shipped with the app, with human names (endonyms). */
	private function availableLanguages(): array {
		$names = [
			'ja' => '日本語', 'en' => 'English', 'zh_CN' => '简体中文', 'es' => 'Español',
			'fr' => 'Français', 'de' => 'Deutsch', 'ru' => 'Русский', 'pt_BR' => 'Português (Brasil)', 'pt_PT' => 'Português (Portugal)',
			'ar' => 'العربية', 'hi' => 'हिन्दी', 'ko' => '한국어', 'it' => 'Italiano',
			'cs' => 'Čeština', 'fa' => 'فارسی', 'id' => 'Bahasa Indonesia', 'pl' => 'Polski',
			'th' => 'ไทย', 'tr' => 'Türkçe', 'uk' => 'Українська', 'vi' => 'Tiếng Việt',
		];
		$out = [];
		foreach (glob(__DIR__ . '/../../l10n/*.json') ?: [] as $path) {
			$code = basename($path, '.json');
			if (isset(Application::OLD_LANGUAGES[$code])) {
				continue; // l10n/zh.json: the same strings as zh_CN, kept for the browser fallback
			}
			$out[] = ['code' => $code, 'name' => $names[$code] ?? $code];
		}
		return $out;
	}

	/**
	 * The RegiBase language setting. The Portuguese strings are Brazilian and were shipped
	 * as "pt" until 2026-09, the Chinese as "zh" until 2026-10; a stored "pt" now means
	 * "pt_BR" and a stored "zh" "zh_CN" (Application::OLD_LANGUAGES).
	 */
	private function userLanguage(string $uid): string {
		$lang = $this->config->getUserValue($uid, Application::APP_ID, 'language', 'auto');
		return Application::OLD_LANGUAGES[$lang] ?? $lang;
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

	/**
	 * The full Unicode 14.0 emoji set for the icon picker, plus the CLDR names and
	 * keywords in $lang so the picker can be searched in the user's own language.
	 * Fetched lazily (only when the picker is first opened) — it is ~150 KB.
	 * 'auto' follows the Nextcloud language; anything unknown falls back to English.
	 */
	#[NoAdminRequired]
	public function getEmoji(string $lang = 'auto'): JSONResponse {
		if (!in_array($lang, $this->languageCodes(), true)) {
			$lang = substr($this->l10nFactory->findLanguage(Application::APP_ID), 0, 2);
		}
		$base = realpath(__DIR__ . '/../../data/emoji');
		if ($base === false) {
			return $this->notFound();
		}
		$names = realpath($base . '/' . $lang . '.json');
		if ($names === false) {
			// the emoji names exist per language, not per region (pt_BR → pt)
			$names = realpath($base . '/' . substr($lang, 0, 2) . '.json');
		}
		if ($names === false || strpos($names, $base) !== 0) {
			$names = $base . '/en.json';
		}
		$list = json_decode((string)file_get_contents($base . '/list.json'), true);
		return new JSONResponse([
			'version' => $list['version'] ?? '',
			'groups' => $list['groups'] ?? [],
			'names' => json_decode((string)file_get_contents($names), true) ?: [],
		]);
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
			$lang = Application::OLD_LANGUAGES[$lang] ?? $lang;
			if ($lang === 'auto' || in_array($lang, $this->languageCodes(), true)) {
				$this->config->setUserValue($uid, Application::APP_ID, 'language', $lang);
			}
		}
		if (array_key_exists('map_provider', $params)) {
			$mp = (string)$params['map_provider'];
			if (in_array($mp, ['google', 'yahoo', 'osm', 'apple', 'bing'], true)) {
				$this->config->setUserValue($uid, Application::APP_ID, 'map_provider', $mp);
			}
		}
		if (array_key_exists('undo_limit', $params)) {
			$this->service->setUndoLimit($uid, (int)$params['undo_limit']);
		}
		if (array_key_exists('version_keep', $params)) {
			$this->service->setVersionKeep($uid, (int)$params['version_keep']);
		}
		if (array_key_exists('version_when', $params)) {
			$when = (string)$params['version_when'];
			if (in_array($when, ['manual', 'auto'], true)) {
				$this->service->setVersionWhen($uid, $when);
			}
		}
		// Width of the AI assistant's column: pixels (240-1200) or a percentage (15-60).
		if (array_key_exists('ai_width', $params) && preg_match('/^(\d+(?:\.\d+)?)(px|%)$/', (string)$params['ai_width'], $m)) {
			$n = (float)$m[1];
			$n = $m[2] === '%' ? min(60.0, max(15.0, $n)) : min(1200.0, max(240.0, $n));
			$this->config->setUserValue($uid, Application::APP_ID, 'ai_width', (round($n * 100) / 100) . $m[2]);
		}
		// Encryption metadata: salt + verifier (ciphertext) + on/off flag. No key material.
		if (array_key_exists('enc_salt', $params) && self::encValueOk('enc_salt', $params['enc_salt'])) {
			$this->config->setUserValue($uid, Application::APP_ID, 'enc_salt', (string)$params['enc_salt']);
		}
		if (array_key_exists('enc_kdf_iter', $params) && self::encValueOk('enc_kdf_iter', $params['enc_kdf_iter'])) {
			$this->config->setUserValue($uid, Application::APP_ID, 'enc_kdf_iter', (string)$params['enc_kdf_iter']);
		} elseif (array_key_exists('enc_salt', $params) && self::encValueOk('enc_salt', $params['enc_salt'])) {
			// a new salt from a page that does not send the rounds: it used 250000 (review K17)
			$this->config->setUserValue($uid, Application::APP_ID, 'enc_kdf_iter', (string)\OCA\RegiBase\Service\Kdf::LEGACY);
		}
		if (array_key_exists('enc_verifier', $params) && self::encValueOk('enc_verifier', $params['enc_verifier'])) {
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
	// The login password is checked here, outside Nextcloud's own login: without the
	// throttle this was a place to try passwords without limit (review P5).
	#[NoAdminRequired]
	#[BruteForceProtection(action: 'regibase_backup')]
	public function backup(): JSONResponse|StreamResponse {
		$uid = $this->uid();
		$l = $this->appL10n();
		$password = (string)$this->request->getParam('password', '');
		if ($password === '' || $this->userManager->checkPassword($uid, $password) === false) {
			$res = new JSONResponse(['error' => $l->t('Incorrect password')], Http::STATUS_FORBIDDEN);
			$res->throttle(['uid' => $uid]);
			return $res;
		}
		// The archive can have a password of its own. With the login password on it, a
		// backup that got out was a way to find the login password, the ZIP's AES key being
		// quick to try (review K10). The login password above still says who is asking.
		$archivePassword = (string)$this->request->getParam('archive_password', '');
		if ($archivePassword !== '' && mb_strlen($archivePassword) < self::ARCHIVE_PASSWORD_MIN) {
			return new JSONResponse(['error' => $l->t('The archive password must be at least 8 characters')], Http::STATUS_BAD_REQUEST);
		}
		$zipPassword = $archivePassword !== '' ? $archivePassword : $password;
		$export = $this->service->exportAll($uid);
		$struct = $export['struct'];

		// Each attachment is copied to a temporary file and added from there; they used to
		// be held in memory all at once, and a few hundred MB of them failed the backup (review K11).
		$attachments = [];
		$files = [];
		foreach ($export['attachmentIds'] as $id) {
			$part = $this->tempManager->getTemporaryFile();
			$name = $part !== false ? $this->images->copyToLocal($uid, (string)$id, $part) : null;
			if ($name !== null) {
				$files[(string)$id] = $part;
				$attachments[] = ['id' => (string)$id, 'name' => $name];
			} elseif ($part !== false) {
				@unlink($part);
			}
		}
		$struct['attachments'] = $attachments;
		$struct['settings'] = [
			'files_folder' => $this->images->getBaseFolder($uid),
			'theme' => $this->config->getUserValue($uid, Application::APP_ID, 'theme', 'auto'),
			'language' => $this->userLanguage($uid),
			'enc_enabled' => $this->config->getUserValue($uid, Application::APP_ID, 'enc_enabled', '0'),
			'enc_salt' => $this->config->getUserValue($uid, Application::APP_ID, 'enc_salt', ''),
			'enc_verifier' => $this->config->getUserValue($uid, Application::APP_ID, 'enc_verifier', ''),
			'enc_kdf_iter' => (string)\OCA\RegiBase\Service\Kdf::iterFor($this->config, $uid),
		];
		// the rest of the user's RegiBase settings (review P10)
		foreach (['map_provider', 'undo_limit', 'version_keep', 'version_when'] as $k) {
			$v = $this->config->getUserValue($uid, Application::APP_ID, $k, '');
			if ($v !== '') {
				$struct['settings'][$k] = $v;
			}
		}

		$tmp = $this->tempManager->getTemporaryFile('.zip');
		$zip = new \ZipArchive();
		if ($zip->open($tmp, \ZipArchive::CREATE | \ZipArchive::OVERWRITE) !== true) {
			array_map('unlink', $files);
			return new JSONResponse(['error' => $l->t('Failed to create the backup')], Http::STATUS_INTERNAL_SERVER_ERROR);
		}
		$zip->setPassword($zipPassword);
		$zip->addFromString('data.json', (string)json_encode($struct, JSON_UNESCAPED_UNICODE | JSON_PRETTY_PRINT));
		$zip->setEncryptionName('data.json', \ZipArchive::EM_AES_256);
		foreach ($files as $id => $part) {
			$entry = 'files/' . $id;
			$zip->addFile($part, $entry);
			$zip->setEncryptionName($entry, \ZipArchive::EM_AES_256);
		}
		$closed = $zip->close();
		array_map('unlink', $files);
		$fh = $closed ? fopen($tmp, 'rb') : false;
		// the open handle keeps the ZIP readable; nothing is left behind on disk
		@unlink($tmp);
		if ($fh === false) {
			return new JSONResponse(['error' => $l->t('Failed to create the backup')], Http::STATUS_INTERNAL_SERVER_ERROR);
		}

		// Sent a chunk at a time instead of being read whole into memory (review K11).
		$safeUid = preg_replace('/[^A-Za-z0-9._-]+/', '_', $uid);
		$fname = 'RegiBase-' . $safeUid . '_' . gmdate('Ymd') . '_backup.zip';
		$res = new StreamResponse($fh);
		$res->addHeader('Content-Type', 'application/zip');
		$res->addHeader('Content-Disposition', 'attachment; filename="' . $fname . '"');
		$res->addHeader('Content-Length', (string)fstat($fh)['size']);
		return $res;
	}

	/**
	 * Restore a backup ZIP. Decrypts with the supplied password (same one used
	 * at creation), then REPLACES all existing RegiBase data with its contents.
	 */
	#[NoAdminRequired]
	#[BruteForceProtection(action: 'regibase_backup')]
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
		// Who is asking is the login password; what opens the archive is its own password
		// when it was given one, else the login password (review K10). The login password was
		// only ever checked by opening the archive with it.
		$archivePassword = (string)$this->request->getParam('archive_password', '');
		if ($this->userManager->checkPassword($uid, $password) === false) {
			$res = new JSONResponse(['error' => $l->t('Incorrect password')], Http::STATUS_FORBIDDEN);
			$res->throttle(['uid' => $uid]);
			return $res;
		}
		$zipPassword = $archivePassword !== '' ? $archivePassword : $password;
		// The ZIP comes as an uploaded file and is opened where PHP put it. It used to come
		// as a base64 data URL inside the JSON body, which held it in memory 4-5 times over
		// (review K11). A data URL is still taken, for older pages.
		$upload = $this->request->getUploadedFile('backup');
		if (is_array($upload) && ($upload['error'] ?? UPLOAD_ERR_NO_FILE) === UPLOAD_ERR_OK
			&& is_string($upload['tmp_name'] ?? null) && is_uploaded_file($upload['tmp_name'])) {
			$tmp = $this->tempManager->getTemporaryFile('.zip');
			if ($tmp === false || !move_uploaded_file($upload['tmp_name'], $tmp)) {
				return new JSONResponse(['error' => $l->t('The archive is invalid')], Http::STATUS_BAD_REQUEST);
			}
		} else {
			$b64 = $dataUrl;
			if (($p = strpos($b64, 'base64,')) !== false) {
				$b64 = substr($b64, $p + 7);
			}
			unset($dataUrl);
			$bin = base64_decode($b64, true);
			unset($b64);
			if ($bin === false || $bin === '') {
				return new JSONResponse(['error' => $l->t('The archive is invalid')], Http::STATUS_BAD_REQUEST);
			}
			$tmp = $this->tempManager->getTemporaryFile('.zip');
			file_put_contents($tmp, $bin);
			unset($bin);
		}
		$zip = new \ZipArchive();
		if ($zip->open($tmp) !== true) {
			@unlink($tmp);
			return new JSONResponse(['error' => $l->t('Cannot open the archive')], Http::STATUS_BAD_REQUEST);
		}
		$zip->setPassword($zipPassword);
		// a data.json that unpacks to more than this is refused before it is read (review P10)
		$st = $zip->statName('data.json');
		if (is_array($st) && (int)($st['size'] ?? 0) > self::BACKUP_JSON_MAX) {
			$zip->close();
			@unlink($tmp);
			return new JSONResponse(['error' => $l->t('The archive contents are invalid')], Http::STATUS_BAD_REQUEST);
		}
		$json = $zip->getFromName('data.json');
		if ($json === false) {
			$zip->close();
			@unlink($tmp);
			$res = new JSONResponse(['error' => $l->t('Wrong password or corrupted archive')], Http::STATUS_FORBIDDEN);
			$res->throttle(['uid' => $uid]);
			return $res;
		}
		$struct = json_decode($json, true);
		// Everything is checked before anything is touched: an overwrite used to wipe every
		// collection first and then stop half way on a malformed entry, with nothing
		// restored and nothing left (review K5).
		if (!is_array($struct) || !self::backupLooksWhole($struct)) {
			$zip->close();
			@unlink($tmp);
			return new JSONResponse(['error' => $l->t('The archive contents are invalid')], Http::STATUS_BAD_REQUEST);
		}

		// Merged or added secrets from a backup made under another master key could not be
		// read afterwards, without a word (review K7). An overwrite brings its key settings along.
		if ($mode !== 'overwrite' && self::backupHasSecrets($struct)
			&& (string)($struct['settings']['enc_salt'] ?? '') !== $this->config->getUserValue($uid, Application::APP_ID, 'enc_salt', '')) {
			$zip->close();
			@unlink($tmp);
			return new JSONResponse(['error' => $l->t('This backup was made with another master key, so its secret fields could not be read after merging or adding. Set the master key the backup was made with first, or restore by overwriting.')], Http::STATUS_CONFLICT);
		}

		// re-save attachments, mapping old fileId → new fileId
		$fileIdMap = [];
		$failedFiles = 0;
		// Each file once, at most ATTACH_MAX of them and ATTACH_TOTAL_MAX bytes in all: one
		// highly compressed entry named thousands of times was written out as many times,
		// limited only by the quota (review, second look).
		$attachTotal = 0;
		$attachSeen = 0;
		foreach (($struct['attachments'] ?? []) as $att) {
			$oid = (string)($att['id'] ?? '');
			if ($oid === '' || isset($fileIdMap[$oid])) {
				continue;
			}
			$st = $zip->statName('files/' . $oid);
			$attachTotal += is_array($st) ? (int)($st['size'] ?? 0) : 0;
			if (++$attachSeen > self::ATTACH_MAX || $attachTotal > self::ATTACH_TOTAL_MAX) {
				$failedFiles++;
				continue;
			}
			// read as a stream, one attachment at a time (review K11)
			$fileStream = $st !== false ? $zip->getStream('files/' . $oid) : false;
			if ($fileStream === false) {
				$failedFiles++;
				continue;
			}
			try {
				$fileIdMap[$oid] = (string)$this->images->saveRaw($uid, (string)($att['name'] ?? 'file'), $fileStream);
			} catch (\Throwable $e) {
				// an attachment that cannot be saved does not stop the restore; it is counted and reported (review K16)
				$failedFiles++;
			} finally {
				if (is_resource($fileStream)) {
					fclose($fileStream);
				}
			}
		}
		$zip->close();
		@unlink($tmp);

		// The settings, the wipe and the import go in one transaction: if any of it fails,
		// the collections as they were come back.
		$db = \OCP\Server::get(\OCP\IDBConnection::class);
		$db->beginTransaction();
		try {
			// settings are only restored for a full overwrite; merge/add keep current settings
			if ($mode === 'overwrite' && is_array($struct['settings'] ?? null)) {
				$s = $struct['settings'];
				if (isset($s['language']) && is_string($s['language'])) {
					$s['language'] = Application::OLD_LANGUAGES[$s['language']] ?? $s['language']; // a backup from before the rename
				}
				if (isset($s['files_folder'])) {
					$this->images->setBaseFolder($uid, (string)$s['files_folder']);
				}
				// each value only when it is one the settings page could have saved (review, second look)
				$allowed = [
					'theme' => fn ($v) => in_array($v, self::ALLOWED_THEMES, true),
					'language' => fn ($v) => $v === 'auto' || in_array($v, $this->languageCodes(), true),
					'enc_enabled' => fn ($v) => $v === '0' || $v === '1',
					'enc_salt' => fn ($v) => self::encValueOk('enc_salt', $v),
					'enc_verifier' => fn ($v) => self::encValueOk('enc_verifier', $v),
					'map_provider' => fn ($v) => in_array($v, ['google', 'yahoo', 'osm', 'apple', 'bing'], true),
				];
				foreach ($allowed as $k => $ok) {
					if (array_key_exists($k, $s) && is_scalar($s[$k]) && $ok((string)$s[$k])) {
						$this->config->setUserValue($uid, Application::APP_ID, $k, (string)$s[$k]);
					}
				}
				if (isset($s['undo_limit']) && is_numeric($s['undo_limit'])) {
					$this->service->setUndoLimit($uid, (int)$s['undo_limit']);
				}
				if (isset($s['version_keep']) && is_numeric($s['version_keep'])) {
					$this->service->setVersionKeep($uid, (int)$s['version_keep']);
				}
				if (in_array($s['version_when'] ?? null, ['manual', 'auto'], true)) {
					$this->service->setVersionWhen($uid, (string)$s['version_when']);
				}
				// the rounds its master key was made with; a backup from before they were kept
				// was made with 250000 (review K17)
				if (array_key_exists('enc_salt', $s)) {
					$this->config->setUserValue($uid, Application::APP_ID, 'enc_kdf_iter',
						(string)(\OCA\RegiBase\Service\Kdf::valid($s['enc_kdf_iter'] ?? null) ? $s['enc_kdf_iter'] : \OCA\RegiBase\Service\Kdf::LEGACY));
				}
			}
			$result = $this->service->importAll($uid, $struct, $fileIdMap, $mode);
			$db->commit();
		} catch (\Throwable $e) {
			$db->rollBack();
			// the copies of the attachments made for this restore go too: "nothing was changed"
			// left them behind, one more set with every retry (review, second look)
			$restored = $this->images->getBaseFolder($uid) . '/_restored';
			foreach ($fileIdMap as $newId) {
				$this->images->trashIfOwned($uid, (string)$newId, $restored);
			}
			return new JSONResponse(['error' => $l->t('The restore could not be completed. Nothing was changed.')], Http::STATUS_INTERNAL_SERVER_ERROR);
		}
		// only now that it is all in: the old attachments nothing points at any more go to the trash
		$this->service->trashAfterRestore($uid, $result['_trash'] ?? [], $result['_held'] ?? []);
		unset($result['_trash'], $result['_held']);
		$result['attachments_failed'] = $failedFiles;
		return new JSONResponse($result);
	}

	/** Whether a backup holds encrypted values (or collection keys wrapped with its master key). */
	private static function backupHasSecrets(array $struct): bool {
		foreach ($struct['collections'] ?? [] as $col) {
			if (!empty($col['key_wrap'])) {
				return true;
			}
			foreach ($col['records'] ?? [] as $r) {
				foreach (is_array($r['data'] ?? null) ? $r['data'] : [] as $v) {
					if (is_string($v) && str_starts_with($v, 'rbenc1:')) {
						return true;
					}
				}
			}
		}
		return false;
	}

	/**
	 * Whether an enc_salt / enc_verifier is of the shape the page writes: a base64 salt, and a
	 * verifier that is encrypted (rbenc1:iv:data). A plain "regibase-ok" verifier let any key
	 * unlock, and what was then encrypted with the wrong key could not be read later (review K14).
	 * Empty means "no master key".
	 */
	private static function encValueOk(string $k, $v): bool {
		if ($k === 'enc_kdf_iter') {
			return \OCA\RegiBase\Service\Kdf::valid($v);
		}
		if (!is_string($v) || $v === '') {
			return $v === '' || $v === null;
		}
		return $k === 'enc_verifier'
			? (bool)preg_match('~^rbenc1:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$~', $v)
			: (bool)preg_match('~^[A-Za-z0-9+/=]{8,}$~', $v);
	}

	/** Most attachment files, and bytes in all, one restore takes (review, second look). */
	private const ATTACH_MAX = 20000;
	private const ATTACH_TOTAL_MAX = 4 * 1024 * 1024 * 1024;

	/** Shortest password an archive may be given of its own (review K10). */
	private const ARCHIVE_PASSWORD_MIN = 8;

	/** Largest data.json a restore will unpack (64 MB). */
	private const BACKUP_JSON_MAX = 64 * 1024 * 1024;

	/** Whether a backup's data.json has the shape importAll() needs, all the way down. */
	private static function backupLooksWhole(array $struct): bool {
		if (!isset($struct['collections']) || !is_array($struct['collections'])) {
			return false;
		}
		foreach ($struct['collections'] as $col) {
			if (!is_array($col)) {
				return false;
			}
			foreach (['name', 'icon', 'color', 'description', 'view', 'key_wrap'] as $k) {
				if (isset($col[$k]) && !is_string($col[$k])) {
					return false;
				}
			}
			foreach (['fields', 'records', 'shares'] as $k) {
				if (isset($col[$k]) && !is_array($col[$k])) {
					return false;
				}
			}
			foreach (($col['fields'] ?? []) as $f) {
				if (!is_array($f) || !is_string($f['key'] ?? null) || $f['key'] === '' || !is_string($f['type'] ?? 'text')) {
					return false;
				}
			}
			foreach (($col['records'] ?? []) as $r) {
				if (!is_array($r) || (isset($r['data']) && !is_array($r['data']))) {
					return false;
				}
			}
		}
		if (isset($struct['templates']) && !is_array($struct['templates'])) {
			return false;
		}
		foreach ($struct['collections'] as $col) {
			foreach (($col['shares'] ?? []) as $sh) {
				if (!is_array($sh) || !is_string($sh['recipient'] ?? '')) {
					return false;
				}
			}
			foreach (($col['records'] ?? []) as $r) {
				if (isset($r['created_at']) && (!is_string($r['created_at']) || strlen($r['created_at']) > 32)) {
					return false;
				}
			}
		}
		foreach (($struct['templates'] ?? []) as $t) {
			if (!is_array($t)) {
				return false;
			}
		}
		foreach (($struct['attachments'] ?? []) as $a) {
			if (!is_array($a) || !is_scalar($a['id'] ?? '') || !is_scalar($a['name'] ?? '')) {
				return false;
			}
		}
		// the master-key settings a restore would bring in are of the right shape (review K14)
		foreach (['enc_salt', 'enc_verifier', 'enc_kdf_iter'] as $k) {
			if (isset($struct['settings'][$k]) && !self::encValueOk($k, $struct['settings'][$k])) {
				return false;
			}
		}
		return isset($struct['attachments']) ? is_array($struct['attachments']) : true;
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
			$folder = $this->attachmentFolder($collectionId);
			$out = $this->images->saveDocument($this->uid(), $folder, $name, $base64);
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
		$meta = $this->images->fileMeta($this->reader($id), $id);
		if ($meta === null) {
			return $this->notFound();
		}
		return new JSONResponse($meta);
	}

	#[NoAdminRequired]
	#[NoCSRFRequired]
	public function getFile(string $id): DataDownloadResponse|JSONResponse {
		$f = $this->images->resolveFile($this->reader($id), $id);
		if ($f === null) {
			return new JSONResponse(['error' => 'not found'], Http::STATUS_NOT_FOUND);
		}
		return new DataDownloadResponse($f['content'], $f['name'], $f['mime']);
	}

	#[NoAdminRequired]
	#[NoCSRFRequired]
	public function getImage(string $id): DataDisplayResponse {
		$img = $this->images->resolve($this->reader($id), $id);
		if ($img === null) {
			return new DataDisplayResponse('', Http::STATUS_NOT_FOUND);
		}
		$resp = new DataDisplayResponse($img['content'], Http::STATUS_OK, ['Content-Type' => $img['mime']]);
		$resp->cacheFor(3600, false, true);
		return $resp;
	}

	/** Whose Files attachment $id is read from: see RegiBaseService::attachmentReader (?c=collection). */
	private function reader(string $id): string {
		return $this->service->attachmentReader($this->uid(), (int)$this->request->getParam('c', 0), $id);
	}

	// ---- internal sharing ----

	/**
	 * The Files-relative folder where a collection's attachments are stored.
	 * Empty (user cleared it) throws so the record editor's warning is enforced.
	 * @throws DoesNotExistException|\RuntimeException
	 */
	private function attachmentFolder(int $collectionId): string {
		if ($collectionId <= 0) {
			return $this->images->getBaseFolder($this->uid()) . '/' . $this->l->t('Uncategorized');
		}
		$coll = $this->service->getCollection($this->uid(), $collectionId);
		// Attachments of a shared collection are the owner's: somebody it is shared with cannot
		// add one, whatever their permission (owner, 2026-09-24), yet the upload itself went
		// through and made a folder in their own Files (review).
		if (empty($coll['is_owner'])) {
			throw new \RuntimeException('Only the owner of the collection can change its attachments.');
		}
		$folder = trim((string)($coll['files_folder'] ?? ''));
		if ($folder === '') {
			throw new \RuntimeException('Set a save folder in the collection settings first.');
		}
		return $folder;
	}

	/** Display name for a uid, falling back to the uid itself. */
	private function displayName(string $uid): string {
		$u = $this->userManager->get($uid);
		return $u ? $u->getDisplayName() : $uid;
	}

	/** Display name for a group id, falling back to the gid itself. */
	private function groupDisplayName(string $gid): string {
		$g = $this->groupManager->get($gid);
		return $g ? $g->getDisplayName() : $gid;
	}

	/** Recipient display name honoring the share type. */
	private function recipientName(string $id, string $type): string {
		return $type === 'group' ? $this->groupDisplayName($id) : $this->displayName($id);
	}

	/** Search users and groups to share with, excluding self. */
	#[NoAdminRequired]
	public function searchUsers(): JSONResponse {
		$q = trim((string)$this->request->getParam('q', ''));
		$me = $this->uid();
		if (mb_strlen($q) < 1) {
			return new JSONResponse(['users' => [], 'groups' => []]);
		}
		// The same search as the Files share dialog, so the administrator's settings apply
		// (user enumeration limits, group-members-only, group sharing off).
		if (!$this->shareManager->shareApiEnabled() || $this->shareManager->sharingDisabledForUser($me)) {
			return new JSONResponse(['users' => [], 'groups' => []]);
		}
		$types = [IShare::TYPE_USER];
		if ($this->shareManager->allowGroupSharing()) {
			$types[] = IShare::TYPE_GROUP;
		}
		[$res] = $this->collaboratorSearch->search($q, $types, false, 25, 0);
		$pick = function (string $kind) use ($res, $me): array {
			$out = [];
			foreach (array_merge($res['exact'][$kind] ?? [], $res[$kind] ?? []) as $e) {
				$id = (string)($e['value']['shareWith'] ?? '');
				if ($id === '' || ($kind === 'users' && $id === $me) || isset($out[$id])) {
					continue;
				}
				$out[$id] = ['type' => $kind === 'users' ? 'user' : 'group', 'uid' => $id, 'name' => (string)($e['label'] ?? $id)];
			}
			return array_slice(array_values($out), 0, 20);
		};
		$users = $pick('users');
		$groups = $pick('groups');
		return new JSONResponse(['users' => $users, 'groups' => $groups]);
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
			$s['recipient_name'] = $this->recipientName((string)$s['recipient_uid'], (string)($s['recipient_type'] ?? 'user'));
		}
		return new JSONResponse(['shares' => $shares]);
	}

	/** Share a collection with a user or a group (owner only). */
	#[NoAdminRequired]
	public function addShare(int $id): JSONResponse {
		$recipient = trim((string)$this->request->getParam('recipient', ''));
		$type = ((string)$this->request->getParam('recipient_type', 'user') === 'group') ? 'group' : 'user';
		$perm = (string)$this->request->getParam('perm', 'view');
		$auth = $this->request->getParam('auth');
		$authSalt = $this->request->getParam('auth_salt');
		$encKey = $this->request->getParam('enc_key');
		$encSalt = $this->request->getParam('enc_salt');
		$expires = $this->request->getParam('expires_at');
		$l = $this->appL10n();
		// The share password must never come here as it is (review K3). A page from
		// before this change still sends it: refuse, so it is reloaded.
		if ($this->request->getParam('password') !== null) {
			return new JSONResponse(['error' => $l->t('Please reload the page and try again.')], Http::STATUS_BAD_REQUEST);
		}
		if ($recipient === '') {
			return new JSONResponse(['error' => $l->t('No such user')], Http::STATUS_BAD_REQUEST);
		}
		if ($type === 'user' && $this->userManager->get($recipient) === null) {
			return new JSONResponse(['error' => $l->t('No such user')], Http::STATUS_BAD_REQUEST);
		}
		if ($type === 'group' && !$this->groupManager->groupExists($recipient)) {
			return new JSONResponse(['error' => $l->t('No such group')], Http::STATUS_BAD_REQUEST);
		}
		try {
			$s = $this->service->addShare($this->uid(), $id, $recipient,
				$perm,
				is_string($auth) ? $auth : null,
				is_string($authSalt) ? $authSalt : null,
				is_string($encKey) ? $encKey : null,
				is_string($encSalt) ? $encSalt : null,
				is_string($expires) ? $expires : null,
				$type);
			$s['recipient_name'] = $this->recipientName($recipient, $type);
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
		$type = ((string)$this->request->getParam('recipient_type', 'user') === 'group') ? 'group' : 'user';
		$patch = [];
		if ($this->request->getParam('password') !== null) {
			return new JSONResponse(['error' => $this->appL10n()->t('Please reload the page and try again.')], Http::STATUS_BAD_REQUEST);
		}
		foreach (['perm', 'auth', 'auth_salt', 'enc_key', 'enc_salt', 'expires_at'] as $k) {
			if ($this->request->getParam($k) !== null) {
				$patch[$k] = $this->request->getParam($k);
			}
		}
		try {
			$s = $this->service->updateShare($this->uid(), $id, $uid, $patch, $type);
			$s['recipient_name'] = $this->recipientName($uid, $type);
			return new JSONResponse($s);
		} catch (DoesNotExistException $e) {
			return $this->notFound();
		} catch (\RuntimeException $e) {
			return new JSONResponse(['error' => $this->appL10n()->t($e->getMessage())], Http::STATUS_BAD_REQUEST);
		}
	}

	/** Remove a share (owner only). */
	#[NoAdminRequired]
	public function removeShare(int $id, string $uid): JSONResponse {
		$type = ((string)$this->request->getParam('recipient_type', 'user') === 'group') ? 'group' : 'user';
		try {
			$this->service->removeShare($this->uid(), $id, $uid, $type);
			return new JSONResponse(['ok' => true]);
		} catch (DoesNotExistException $e) {
			return $this->notFound();
		}
	}

	/** Recipient unlocks a shared collection (verify share password, get wrapped key). */
	#[NoAdminRequired]
	#[BruteForceProtection(action: 'regibase_share_unlock')]
	public function unlockShare(int $id): JSONResponse {
		// a value derived from the share password in the page, never the password (review K3)
		$auth = (string)$this->request->getParam('auth', '');
		try {
			return new JSONResponse($this->service->unlockShare($this->uid(), $id, $auth));
		} catch (ForbiddenException $e) {
			$res = new JSONResponse(['error' => $this->appL10n()->t('Incorrect share password')], Http::STATUS_FORBIDDEN);
			$res->throttle(['uid' => $this->uid(), 'collection' => $id]);
			return $res;
		} catch (DoesNotExistException $e) {
			return $this->notFound();
		}
	}
}
