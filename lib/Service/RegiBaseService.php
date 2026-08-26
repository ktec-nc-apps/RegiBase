<?php

declare(strict_types=1);

namespace OCA\RegiBase\Service;

use OCA\RegiBase\Db\CollectionEntity;
use OCA\RegiBase\Db\CollectionMapper;
use OCA\RegiBase\Db\FieldEntity;
use OCA\RegiBase\Db\FieldMapper;
use OCA\RegiBase\Db\RecordEntity;
use OCA\RegiBase\Db\RecordMapper;
use OCA\RegiBase\Db\ShareEntity;
use OCA\RegiBase\Db\ShareMapper;
use OCP\AppFramework\Db\DoesNotExistException;
use OCP\IGroupManager;
use OCP\IL10N;
use OCP\ISession;
use OCP\IUserManager;

class RegiBaseService {
	private const ALLOWED_VIEWS = ['card', 'list', 'table', 'note'];
	private const ALLOWED_SORTS = ['created_asc', 'created_desc', 'title_asc', 'title_desc'];
	private const KEY_SEPS = ['none', 'space', 'fullspace', 'custom'];
	/** Field concat separators: KEY_SEPS plus 'paren' (wrap the target in （ ）). */
	private const CONCAT_SEPS = ['none', 'space', 'fullspace', 'custom', 'paren', 'parenfull'];
	private const ATTACH_TYPES = ['image', 'image_crop', 'file'];
	// Per-collection map service override; '' means "inherit the global setting".
	private const MAP_PROVIDERS = ['', 'google', 'yahoo', 'osm', 'apple', 'bing'];
	// recipient permission ranks; owner is implicitly above all of these
	public const PERM_VIEW = 'view';
	public const PERM_EDIT = 'edit';
	public const PERM_DELETE = 'delete';
	private const PERM_RANK = ['view' => 1, 'edit' => 2, 'delete' => 3];

	public function __construct(
		private CollectionMapper $collections,
		private FieldMapper $fields,
		private RecordMapper $records,
		private ShareMapper $shares,
		private ImageService $images,
		private IL10N $l,
		private ISession $session,
		private HistoryService $history,
		private IUserManager $userManager,
		private IGroupManager $groupManager,
	) {
	}

	/** Group ids the user belongs to (empty if the user is unknown). @return string[] */
	private function userGroupIds(string $userId): array {
		$u = $this->userManager->get($userId);
		return $u ? $this->groupManager->getUserGroupIds($u) : [];
	}

	/**
	 * The single most-privileged share granting $userId access to a collection,
	 * considering both a direct user-share and any group-shares. Null if none.
	 * On an equal permission level a direct user-share wins over a group-share.
	 */
	private function bestShare(int $collectionId, string $userId): ?ShareEntity {
		$candidates = $this->shares->findForUserAccess($collectionId, $userId, $this->userGroupIds($userId));
		$best = null;
		$bestRank = -1;
		foreach ($candidates as $s) {
			$rank = self::PERM_RANK[$s->getPerm()] ?? 0;
			$isUser = $s->getRecipientType() === 'user';
			if ($best === null || $rank > $bestRank || ($rank === $bestRank && $isUser)) {
				$best = $s;
				$bestRank = $rank;
			}
		}
		return $best;
	}

	/** Best-effort append to the undo/change-history journal (never blocks the op). */
	private function rec(string $userId, string $op, ?int $collectionId, string $summary, array $undo, ?string $grp = null): void {
		try {
			$this->history->record($userId, $op, $collectionId, $summary, $undo, $grp);
		} catch (\Throwable $e) {
			// history is a safety net; a failure to record must not fail the action
		}
	}

	private function unlockKey(int $collectionId): string {
		return 'regibase_unlocked_' . $collectionId;
	}

	private function isShareUnlocked(int $collectionId): bool {
		return $this->session->get($this->unlockKey($collectionId)) === true;
	}

	private function markShareUnlocked(int $collectionId): void {
		$this->session->set($this->unlockKey($collectionId), true);
	}

	// ---- access control (owner or share recipient) ----

	/**
	 * Resolve a collection for a user, honoring shares.
	 * @return array{0: CollectionEntity, 1: string, 2: bool, 3: ?ShareEntity}
	 *   [entity, perm ('owner'|'view'|'edit'|'delete'), isOwner, share|null]
	 * @throws DoesNotExistException if the user can neither own nor access it
	 */
	private function resolve(string $userId, int $id): array {
		try {
			$c = $this->collections->findForUser($id, $userId);
			return [$c, 'owner', true, null];
		} catch (DoesNotExistException $e) {
			// fall through: maybe it is shared to this user
		}
		$share = $this->bestShare($id, $userId);
		if ($share === null) {
			throw new DoesNotExistException('no access to collection');
		}
		// a password-protected share must be unlocked in this session first
		if ($share->getPwHash() !== null && $share->getPwHash() !== '' && !$this->isShareUnlocked($id)) {
			throw new LockedException('share is locked');
		}
		return [$this->collections->findById($id), $share->getPerm(), false, $share];
	}

	/**
	 * Like resolve(), but require at least $min permission (owner always passes).
	 * @throws DoesNotExistException|ForbiddenException
	 */
	private function require(string $userId, int $id, string $min): array {
		$res = $this->resolve($userId, $id);
		[, $perm, $isOwner] = $res;
		if (!$isOwner) {
			$have = self::PERM_RANK[$perm] ?? 0;
			$need = self::PERM_RANK[$min] ?? 99;
			if ($have < $need) {
				throw new ForbiddenException('permission denied');
			}
		}
		return $res;
	}

	/** Throw if the collection is edit-locked (view only). */
	private function assertEditable(CollectionEntity $c): void {
		if ($c->getLocked()) {
			throw new ForbiddenException('collection is edit-locked (view only)');
		}
	}

	/** Like require(), but also rejects the call when the collection is edit-locked. */
	private function requireEditable(string $userId, int $id, string $min): array {
		$res = $this->require($userId, $id, $min);
		$this->assertEditable($res[0]);
		return $res;
	}

	/** Attachment-type fields of a collection (as jsonSerialized arrays). */
	private function attachmentFields(int $collectionId): array {
		$fieldsJson = array_map(fn (FieldEntity $f) => $f->jsonSerialize(), $this->fields->findForCollection($collectionId));
		return array_values(array_filter($fieldsJson, fn ($f) => in_array($f['type'], self::ATTACH_TYPES, true)));
	}

	/** Move any RegiBase-owned attachments referenced in $data to the trash. */
	private function trashDataAttachments(string $userId, array $attachFields, array $data): void {
		foreach ($attachFields as $f) {
			$v = $data[$f['key']] ?? '';
			if ($v !== '' && $v !== null) {
				$this->images->trashIfOwned($userId, (string)$v);
			}
		}
	}

	private function now(): string {
		return gmdate('Y-m-d\TH:i:s\Z');
	}

	// ---- collections ----

	/** Add sharing metadata (badge + permission flags) to a collection's json. */
	private function decorateShare(array $j, bool $isOwner, ?ShareEntity $share): array {
		$cid = (int)$j['id'];
		if ($isOwner) {
			$sharedByMe = $this->shares->collectionIsShared($cid);
			$j['is_owner'] = true;
			$j['perm'] = 'owner';
			$j['shared'] = $sharedByMe;
			$j['shared_by_me'] = $sharedByMe;
			$j['shared_with_me'] = false;
			$j['has_password'] = false;
			$j['can_see_secrets'] = true; // owner decrypts with their own master key
		} else {
			$j['is_owner'] = false;
			$j['perm'] = $share->getPerm();
			$j['shared'] = true;
			$j['shared_by_me'] = false;
			$j['shared_with_me'] = true;
			$j['owner_uid'] = $share->getOwnerUid();
			$j['has_password'] = $share->getPwHash() !== null && $share->getPwHash() !== '';
			$j['can_see_secrets'] = $share->getEncKey() !== null && $share->getEncKey() !== '';
		}
		return $j;
	}

	public function listCollections(string $userId): array {
		$out = [];
		foreach ($this->collections->findAllForUser($userId) as $c) {
			// secret collections are hidden until the session is unlocked with the
			// matching 6-digit key (see revealSecretCollections()).
			if ($c->getSecret()) {
				continue;
			}
			$j = $c->jsonSerialize();
			$j['record_count'] = $this->records->countForCollection((int)$c->getId());
			$out[] = $this->decorateShare($j, true, null);
		}
		// collections other users have shared with me — directly or via a group.
		// A collection reachable through several shares appears once, at the
		// highest permission level.
		$bestByColl = [];
		foreach ($this->shares->findAllForUserAccess($userId, $this->userGroupIds($userId)) as $share) {
			$cid = (int)$share->getCollectionId();
			$rank = self::PERM_RANK[$share->getPerm()] ?? 0;
			$curRank = isset($bestByColl[$cid]) ? (self::PERM_RANK[$bestByColl[$cid]->getPerm()] ?? 0) : -1;
			$isUser = $share->getRecipientType() === 'user';
			if (!isset($bestByColl[$cid]) || $rank > $curRank
				|| ($rank === $curRank && $isUser)) {
				$bestByColl[$cid] = $share;
			}
		}
		foreach ($bestByColl as $cid => $share) {
			try {
				$c = $this->collections->findById($cid);
			} catch (DoesNotExistException $e) {
				continue; // stale share whose collection was deleted
			}
			$j = $c->jsonSerialize();
			$j['record_count'] = $this->records->countForCollection((int)$c->getId());
			$out[] = $this->decorateShare($j, false, $share);
		}
		return $out;
	}

	/** A secret collection key is exactly six digits. */
	private static function isValidSecretPin(string $pin): bool {
		return (bool)preg_match('/^\d{6}$/', $pin);
	}

	/**
	 * Return the caller's own secret collections whose 6-digit key matches $pin.
	 * Used by the "secret toggle" to reveal hidden collections for the session
	 * (nothing is persisted server-side — the client keeps them until it reloads
	 * or hides them again). Returns [] for a malformed pin or no match, so a wrong
	 * key is indistinguishable from "no secret collections".
	 */
	public function revealSecretCollections(string $userId, string $pin): array {
		$pin = trim($pin);
		if (!self::isValidSecretPin($pin)) {
			return [];
		}
		$out = [];
		foreach ($this->collections->findAllForUser($userId) as $c) {
			if (!$c->getSecret()) {
				continue;
			}
			$hash = (string)$c->getSecretHash();
			if ($hash !== '' && password_verify($pin, $hash)) {
				$j = $c->jsonSerialize();
				$j['record_count'] = $this->records->countForCollection((int)$c->getId());
				$out[] = $this->decorateShare($j, true, null);
			}
		}
		return $out;
	}

	/**
	 * Reassign the sidebar order (`sort` position) of the user's own collections
	 * to match the given id order (position 1..N). Ids that aren't owned by the
	 * user are ignored; collections omitted from $orderedIds keep their current
	 * relative order and are appended after the listed ones.
	 * @return int number of collections whose position actually changed
	 */
	public function reorderCollections(string $userId, array $orderedIds): int {
		$own = $this->collections->findAllForUser($userId);
		$byId = [];
		foreach ($own as $c) {
			$byId[(int)$c->getId()] = $c;
		}

		$seen = [];
		$sequence = [];
		foreach ($orderedIds as $id) {
			$id = (int)$id;
			if (isset($byId[$id]) && !isset($seen[$id])) {
				$sequence[] = $byId[$id];
				$seen[$id] = true;
			}
		}
		foreach ($own as $c) {
			$id = (int)$c->getId();
			if (!isset($seen[$id])) {
				$sequence[] = $c;
				$seen[$id] = true;
			}
		}

		$pos = 0;
		$changed = 0;
		foreach ($sequence as $c) {
			$pos++;
			if ((int)$c->getSort() !== $pos) {
				$c->setSort($pos);
				$this->collections->update($c);
				$changed++;
			}
		}
		return $changed;
	}

	public function getCollection(string $userId, int $id): array {
		[$c, , $isOwner, $share] = $this->resolve($userId, $id);
		$j = $c->jsonSerialize();
		$j['fields'] = array_map(fn (FieldEntity $f) => $f->jsonSerialize(), $this->fields->findForCollection($id));
		$out = $this->decorateShare($j, $isOwner, $share);
		if ($isOwner) {
			// Flag when another collection shares this save folder, so the delete
			// dialog can refuse to remove the folder (it would take the other
			// collection's attachments with it).
			$out['folder_shared'] = $this->folderSharedByOthers($userId, (int)$id, (string)$c->getFilesFolder());
		}
		return $out;
	}

	/**
	 * Save folders (Files-relative) currently used by this user's collections,
	 * excluding collection $exceptId (0 = none). Keyed by folder path.
	 * @return array<string,string> folder => collection name
	 */
	private function foldersInUse(string $userId, int $exceptId): array {
		$used = [];
		foreach ($this->collections->findAllForUser($userId) as $c) {
			if ((int)$c->getId() === $exceptId) {
				continue;
			}
			$f = trim((string)$c->getFilesFolder());
			if ($f !== '') {
				$used[$f] = $c->getName();
			}
		}
		return $used;
	}

	/** The folder a new collection would use for this input: "<base>/<name>". */
	private function intendedFolderFor(string $userId, array $input, IL10N $l): string {
		$tpl = isset($input['template_key']) ? Templates::byKey($l, (string)$input['template_key']) : null;
		$name = (string)($input['name'] ?? ($tpl['name'] ?? $l->t('New collection')));
		return $this->images->getBaseFolder($userId) . '/' . $name;
	}

	/**
	 * If a new collection created from $input would reuse the save folder of an
	 * existing collection, return that folder path; otherwise null.
	 */
	public function collectionFolderConflict(string $userId, array $input, ?IL10N $l = null): ?string {
		$l = $l ?? $this->l;
		$folder = $this->intendedFolderFor($userId, $input, $l);
		return isset($this->foldersInUse($userId, 0)[$folder]) ? $folder : null;
	}

	/** Is $folder the save folder of some other collection (not $exceptId)? */
	public function folderSharedByOthers(string $userId, int $exceptId, string $folder): bool {
		$folder = trim($folder);
		return $folder !== '' && isset($this->foldersInUse($userId, $exceptId)[$folder]);
	}

	/**
	 * First save folder not used by any collection and not present on disk:
	 * "<base>/<name>", then "<base>/<name> (2)", "(3)", …
	 */
	private function uniqueFolder(string $userId, string $base, string $name): string {
		$used = $this->foldersInUse($userId, 0);
		$candidate = $base . '/' . $name;
		$i = 1;
		while (isset($used[$candidate]) || $this->images->folderExists($userId, $candidate)) {
			$i++;
			$candidate = $base . '/' . $name . ' (' . $i . ')';
		}
		return $candidate;
	}

	public function createCollection(string $userId, array $input, ?IL10N $tplL10n = null): array {
		$l = $tplL10n ?? $this->l;
		$tpl = isset($input['template_key']) ? Templates::byKey($l, (string)$input['template_key']) : null;
		$c = new CollectionEntity();
		$c->setUserId($userId);
		$c->setName($input['name'] ?? ($tpl['name'] ?? $l->t('New collection')));
		$c->setIcon($input['icon'] ?? ($tpl['icon'] ?? '📁'));
		$c->setColor($input['color'] ?? ($tpl['color'] ?? '#3b82f6'));
		$c->setDescription($input['description'] ?? ($tpl['description'] ?? ''));
		// New collections default to the spreadsheet (table) view; callers that
		// clone an existing collection (transfer/import) pass their own view.
		$view = $input['view'] ?? 'table';
		$c->setView(in_array($view, self::ALLOWED_VIEWS, true) ? $view : 'table');
		$c->setRecordSort('created_desc');
		$c->setLocked(!empty($input['locked']));
		$c->setKeyHead(!empty($input['key_head']));
		$c->setKeySep(in_array($input['key_sep'] ?? 'space', self::KEY_SEPS, true) ? (string)$input['key_sep'] : 'space');
		$c->setKeySepChar(mb_substr((string)($input['key_sep_char'] ?? ''), 0, 4));
		// Default attachment folder for this collection: "<base>/<name>". When the
		// caller chose "add a number" for a name that clashes with another
		// collection's folder, pick the first free "<name> (n)" instead.
		$base = $this->images->getBaseFolder($userId);
		$c->setFilesFolder(((string)($input['folder_choice'] ?? '') === 'suffix')
			? $this->uniqueFolder($userId, $base, $c->getName())
			: $base . '/' . $c->getName());
		$c->setMapProvider('');
		// Optional: create the collection already secret (hidden behind a 6-digit key).
		if (!empty($input['secret']) && isset($input['secret_pin'])
			&& self::isValidSecretPin(trim((string)$input['secret_pin']))) {
			$c->setSecret(true);
			$c->setSecretHash(password_hash(trim((string)$input['secret_pin']), PASSWORD_DEFAULT));
		}
		$c->setSort($this->collections->maxSort($userId) + 1);
		$c->setCreatedAt($this->now());
		$c->setUpdatedAt($this->now());
		$c = $this->collections->insert($c);
		// Create the attachment folder on disk now, so it exists in Files even
		// before the first attachment is added (best-effort).
		$this->images->ensureFolderExists($userId, (string)$c->getFilesFolder());

		$fields = $input['fields'] ?? ($tpl['fields'] ?? []);
		$this->insertFields((int)$c->getId(), $fields);
		$this->rec($userId, 'collection.create', (int)$c->getId(), $this->l->t('Create the collection “%s”', [$c->getName()]), ['kind' => 'del_collection', 'id' => (int)$c->getId()]);
		return $this->getCollection($userId, (int)$c->getId());
	}

	/**
	 * Duplicate a collection (owner only). Copies fields + settings; when
	 * $withRecords is true also copies every record, duplicating any attachment
	 * files so the copy is fully independent of the original.
	 */
	public function duplicateCollection(string $userId, int $id, bool $withRecords, ?string $name = null): array {
		$src = $this->collections->findForUser($id, $userId); // owner only
		$srcFields = array_map(fn (FieldEntity $f) => $f->jsonSerialize(), $this->fields->findForCollection($id));

		$c = new CollectionEntity();
		$c->setUserId($userId);
		$c->setName(($name !== null && trim($name) !== '') ? trim($name) : trim($src->getName() . ' ' . $this->l->t('(copy)')));
		$c->setIcon($src->getIcon());
		$c->setColor($src->getColor());
		$c->setDescription($src->getDescription() ?? '');
		$c->setView($src->getView());
		$c->setRecordSort($src->getRecordSort());
		$c->setKeyHead($src->getKeyHead());
		$c->setKeySep($src->getKeySep());
		$c->setKeySepChar($src->getKeySepChar());
		$c->setSort($this->collections->maxSort($userId) + 1);
		$c->setCreatedAt($this->now());
		$c->setUpdatedAt($this->now());
		$c = $this->collections->insert($c);
		$newId = (int)$c->getId();
		$this->insertFields($newId, $srcFields);

		if ($withRecords) {
			$attach = $this->attachmentFields($id);
			$newName = $c->getName();
			$dataArray = [];
			foreach ($this->records->findForCollection($id) as $r) {
				$data = json_decode($r->getData() ?: '{}', true);
				$data = is_array($data) ? $data : [];
				if (count($attach) > 0) {
					$data = $this->copyDataAttachments($userId, $attach, $data, $newName);
				}
				$dataArray[] = $data;
			}
			if (count($dataArray) > 0) {
				$this->bulkInsertRecords($newId, $dataArray);
			}
		}
		$this->rec($userId, 'collection.create', $newId, $this->l->t('Duplicate the collection “%s”', [$src->getName()]), ['kind' => 'del_collection', 'id' => $newId]);
		return $this->getCollection($userId, $newId);
	}

	/** Duplicate any RegiBase-owned attachment files referenced in $data; returns updated $data. */
	private function copyDataAttachments(string $userId, array $attachFields, array $data, string $collectionName): array {
		foreach ($attachFields as $f) {
			$v = $data[$f['key']] ?? '';
			if ($v === '' || $v === null) {
				continue;
			}
			try {
				$file = $this->images->fileContentById($userId, (string)$v);
				if ($file === null) {
					continue; // not RegiBase-owned or missing: keep original reference
				}
				$newId = $this->images->saveRaw($userId, $file['name'] ?? 'file', $file['content']);
				$data[$f['key']] = (string)$newId;
			} catch (\Throwable $e) {
				// on failure, leave the original reference in place
			}
		}
		return $data;
	}

	public function updateCollection(string $userId, int $id, array $patch): array {
		// Collection settings (name/icon/color/description/lock/key/view/sort) are
		// owner-only. Share recipients — at any level, including 'delete' — cannot
		// change them; their record-level rights are enforced elsewhere.
		$c = $this->collections->findForUser($id, $userId); // owner only
		$oldName = $c->getName();
		// Don't clutter the undo history with pure display-preference switches
		// (view / sort). Only real settings changes are worth an undo entry.
		if (array_diff(array_keys($patch), ['view', 'record_sort'])) {
			$this->rec($userId, 'collection.update', $id, $this->l->t('Change settings of “%s”', [$c->getName()]), ['kind' => 'restore_collection', 'id' => $id, 'settings' => $c->jsonSerialize()]);
		}
		if (isset($patch['name'])) {
			$c->setName((string)$patch['name']);
		}
		if (isset($patch['icon'])) {
			$c->setIcon((string)$patch['icon']);
		}
		if (isset($patch['color'])) {
			$c->setColor((string)$patch['color']);
		}
		if (isset($patch['description'])) {
			$c->setDescription((string)$patch['description']);
		}
		if (isset($patch['view']) && in_array($patch['view'], self::ALLOWED_VIEWS, true)) {
			$c->setView((string)$patch['view']);
		}
		if (isset($patch['record_sort']) && in_array($patch['record_sort'], self::ALLOWED_SORTS, true)) {
			$c->setRecordSort((string)$patch['record_sort']);
		}
		if (array_key_exists('locked', $patch)) {
			$c->setLocked((bool)$patch['locked']);
		}
		if (array_key_exists('key_head', $patch)) {
			$c->setKeyHead((bool)$patch['key_head']);
		}
		if (isset($patch['key_sep']) && in_array($patch['key_sep'], self::KEY_SEPS, true)) {
			$c->setKeySep((string)$patch['key_sep']);
		}
		if (array_key_exists('key_sep_char', $patch)) {
			$c->setKeySepChar(mb_substr((string)$patch['key_sep_char'], 0, 4));
		}
		if (array_key_exists('files_folder', $patch)) {
			$oldFolder = (string)$c->getFilesFolder();
			$newFolder = mb_substr(trim((string)$patch['files_folder']), 0, 512);
			$c->setFilesFolder($newFolder);
			// A direct edit of the folder path must also update Files itself, not
			// just the database pointer: move (rename) the existing folder to the
			// new location. If there is nothing to move — no old folder, or the
			// destination already exists — just make sure the new folder exists so
			// it shows up in Files. The title-triggered rename below is left to
			// handle the rename-on-rename_folder case.
			if ($newFolder !== '' && $newFolder !== $oldFolder && empty($patch['rename_folder'])) {
				if ($oldFolder === '' || !$this->images->renameFolder($userId, $oldFolder, $newFolder)) {
					$this->images->ensureFolderExists($userId, $newFolder);
				}
			}
		}
		if (isset($patch['map_provider']) && in_array((string)$patch['map_provider'], self::MAP_PROVIDERS, true)) {
			$c->setMapProvider((string)$patch['map_provider']);
		}
		// Secret collection. A new 6-digit key (secret_pin) sets/replaces the hash;
		// the `secret` flag turns hiding on/off. Turning it off clears the hash.
		if (array_key_exists('secret_pin', $patch)) {
			$pin = trim((string)$patch['secret_pin']);
			if ($pin !== '') {
				if (!self::isValidSecretPin($pin)) {
					throw new \InvalidArgumentException($this->l->t('The secret key must be exactly 6 digits.'));
				}
				$c->setSecretHash(password_hash($pin, PASSWORD_DEFAULT));
				$c->setSecret(true);
			}
		}
		if (array_key_exists('secret', $patch)) {
			if ($patch['secret']) {
				if (!$c->getSecretHash()) {
					throw new \InvalidArgumentException($this->l->t('Set a 6-digit secret key to make this collection secret.'));
				}
				$c->setSecret(true);
			} else {
				$c->setSecret(false);
				$c->setSecretHash(null);
			}
		}
		// When the title is renamed AND the user confirmed it in the settings
		// dialog (rename_folder), keep the attachment folder's name in step — but
		// only while it is still the auto-derived one (its last path segment equals
		// the old title). If the user set a custom folder, leave it alone.
		if (isset($patch['name']) && !empty($patch['rename_folder'])) {
			$newName = $c->getName();
			$folder = $c->getFilesFolder();
			if ($newName !== '' && $newName !== $oldName && $folder !== '') {
				$slash = mb_strrpos($folder, '/');
				$parent = $slash === false ? '' : mb_substr($folder, 0, $slash);
				$lastSeg = $slash === false ? $folder : mb_substr($folder, $slash + 1);
				if ($lastSeg === $oldName) {
					$newFolder = ($parent !== '' ? $parent . '/' : '') . $newName;
					// Rename the physical Files folder if it exists (non-fatal:
					// it may not have been created yet if no attachment was saved).
					try {
						$this->images->renameFolder($userId, $folder, $newFolder);
					} catch (\Throwable $e) {
						// ignore — the stored path is updated regardless
					}
					$c->setFilesFolder(mb_substr($newFolder, 0, 512));
				}
			}
		}
		$c->setUpdatedAt($this->now());
		$this->collections->update($c);
		return $this->getCollection($userId, $id);
	}

	public function deleteCollection(string $userId, int $id, bool $deleteFolder = false): void {
		$c = $this->collections->findForUser($id, $userId);
		$folder = (string)$c->getFilesFolder();
		// Snapshot the whole collection (settings + fields + record data) so the
		// deletion can be reversed. Attachment files are trashed below; on undo the
		// data references are restored (files may need restoring from the trash bin).
		$dump = [
			'settings' => $c->jsonSerialize(),
			'fields' => array_map(fn (FieldEntity $f) => $f->jsonSerialize(), $this->fields->findForCollection($id)),
			'records' => array_map(fn (RecordEntity $r) => ['data' => json_decode($r->getData() ?: '{}', true) ?: [], 'sort' => (int)$r->getSort(), 'createdAt' => (string)$r->getCreatedAt()], $this->records->findForCollection($id)),
		];
		$this->rec($userId, 'collection.delete', null, $this->l->t('Delete the collection “%s”', [$c->getName()]), ['kind' => 'recreate_collection', 'dump' => $dump]);
		$attach = $this->attachmentFields($id);
		if (count($attach) > 0) {
			foreach ($this->records->findForCollection($id) as $r) {
				$data = json_decode($r->getData() ?: '{}', true) ?: [];
				$this->trashDataAttachments($userId, $attach, $data);
			}
		}
		$this->fields->deleteForCollection($id);
		$this->records->deleteForCollection($id);
		$this->shares->deleteForCollection($id);
		$this->collections->delete($c);
		// Optionally move this collection's save folder to the trash. Off by
		// default; the caller opts in. Best-effort — never blocks the delete.
		// Safety net: never remove a folder that another collection also uses
		// (that would trash the other collection's attachments).
		if ($deleteFolder && $folder !== '' && !$this->folderSharedByOthers($userId, $id, $folder)) {
			$this->images->trashFolder($userId, $folder);
		}
	}

	// ---- undo / change history ----

	/** List the user's snapshot history (newest first), optionally scoped to one collection. */
	public function history(string $userId, ?int $collectionId = null): array {
		return $this->history->listForUser($userId, $collectionId);
	}

	public function undoLimit(string $userId): int {
		return $this->history->getLimit($userId);
	}

	public function setUndoLimit(string $userId, int $n): int {
		return $this->history->setLimit($userId, $n);
	}

	public function clearHistory(string $userId, ?int $collectionId = null): void {
		$this->history->clearForUser($userId, $collectionId);
	}

	/**
	 * Revert the most recent change (or the whole most-recent grouped action).
	 * @return array{undone:int, summary?:string, collection_id?:?int}
	 */
	public function undo(string $userId, ?int $collectionId = null): array {
		$batch = $this->history->nextUndoBatch($userId, $collectionId); // newest-first
		if (!$batch) {
			return ['undone' => 0];
		}
		$summary = $batch[0]->getSummary();
		$collectionId = null;
		$done = 0;
		foreach ($batch as $entry) {
			try {
				$cid = $this->applyInverse($userId, $this->history->decode($entry));
				if ($cid !== null) {
					$collectionId = $cid;
				}
			} catch (\Throwable $e) {
				// keep going; still mark undone so we never loop on a bad entry
			}
			$this->history->markUndone($entry);
			$done++;
		}
		return ['undone' => $done, 'summary' => $summary, 'collection_id' => $collectionId];
	}

	/**
	 * Revert a collection back to the state it was in *before* the given snapshot
	 * entry: undo every not-yet-undone change in that collection whose id is >=
	 * $targetId, newest first (group batches applied atomically).
	 * @return array{undone:int, collection_id:int}
	 */
	public function undoDownTo(string $userId, int $collectionId, int $targetId): array {
		$done = 0;
		for ($i = 0; $i < 100000; $i++) { // hard cap; the id guard is the real terminator
			$batch = $this->history->nextUndoBatch($userId, $collectionId);
			if (!$batch || (int)$batch[0]->getId() < $targetId) {
				break;
			}
			foreach ($batch as $entry) {
				try {
					$this->applyInverse($userId, $this->history->decode($entry));
				} catch (\Throwable $e) {
					// keep going; still mark undone so we never loop on a bad entry
				}
				$this->history->markUndone($entry);
				$done++;
			}
		}
		return ['undone' => $done, 'collection_id' => $collectionId];
	}

	/** Apply a single inverse payload. Returns the affected collection id if known. */
	private function applyInverse(string $userId, array $p): ?int {
		switch ($p['kind'] ?? '') {
			case 'del_record':
				try {
					$this->records->delete($this->records->find((int)$p['id']));
				} catch (DoesNotExistException $e) {
				}
				return null;
			case 'set_data':
				try {
					$r = $this->records->find((int)$p['id']);
				} catch (DoesNotExistException $e) {
					return null;
				}
				$cid = (int)$r->getCollectionId();
				$data = is_array($p['data'] ?? null) ? $p['data'] : [];
				$fieldsJson = array_map(fn (FieldEntity $f) => $f->jsonSerialize(), $this->fields->findForCollection($cid));
				$r->setData(json_encode($data ?: new \stdClass(), JSON_UNESCAPED_UNICODE));
				$r->setReading($this->computeReading($this->titleFor($fieldsJson, $data)));
				$r->setUpdatedAt($this->now());
				$this->records->update($r);
				return $cid;
			case 'reinsert':
				return $this->reinsertRecord(is_array($p['record'] ?? null) ? $p['record'] : []);
			case 'reinsert_many':
				$cid = null;
				foreach (($p['records'] ?? []) as $rec) {
					$cid = $this->reinsertRecord(is_array($rec) ? $rec : []) ?? $cid;
				}
				return $cid;
			case 'reorder':
				$cid = null;
				foreach (($p['orders'] ?? []) as $pair) {
					if (!is_array($pair) || count($pair) < 2) {
						continue;
					}
					try {
						$r = $this->records->find((int)$pair[0]);
						if ((int)$r->getSort() !== (int)$pair[1]) {
							$r->setSort((int)$pair[1]);
							$this->records->update($r);
						}
						$cid = (int)$r->getCollectionId();
					} catch (DoesNotExistException $e) {
					}
				}
				return $cid;
			case 'del_many':
				foreach (($p['ids'] ?? []) as $id) {
					try {
						$this->records->delete($this->records->find((int)$id));
					} catch (DoesNotExistException $e) {
					}
				}
				return null;
			case 'restore_fields':
				$cid = (int)($p['collectionId'] ?? 0);
				if ($cid > 0) {
					$this->fields->deleteForCollection($cid);
					$this->restoreFields($cid, is_array($p['fields'] ?? null) ? $p['fields'] : []);
				}
				return $cid ?: null;
			case 'del_collection':
				$id = (int)($p['id'] ?? 0);
				try {
					$c = $this->collections->findById($id);
					$this->fields->deleteForCollection($id);
					$this->records->deleteForCollection($id);
					$this->shares->deleteForCollection($id);
					$this->collections->delete($c);
				} catch (DoesNotExistException $e) {
				}
				return null;
			case 'restore_collection':
				return $this->restoreCollectionSettings((int)($p['id'] ?? 0), is_array($p['settings'] ?? null) ? $p['settings'] : []);
			case 'recreate_collection':
				return $this->recreateCollection($userId, is_array($p['dump'] ?? null) ? $p['dump'] : []);
			case 'undo_transfer':
				foreach (($p['createdIds'] ?? []) as $id) {
					try {
						$this->records->delete($this->records->find((int)$id));
					} catch (DoesNotExistException $e) {
					}
				}
				$cid = null;
				foreach (($p['restore'] ?? []) as $rec) {
					$cid = $this->reinsertRecord(is_array($rec) ? $rec : []) ?? $cid;
				}
				return $cid;
		}
		return null;
	}

	private function reinsertRecord(array $rec): ?int {
		$cid = (int)($rec['collectionId'] ?? 0);
		if ($cid <= 0) {
			return null;
		}
		$data = is_array($rec['data'] ?? null) ? $rec['data'] : [];
		$fieldsJson = array_map(fn (FieldEntity $f) => $f->jsonSerialize(), $this->fields->findForCollection($cid));
		$e = new RecordEntity();
		$e->setCollectionId($cid);
		$e->setData(json_encode($data ?: new \stdClass(), JSON_UNESCAPED_UNICODE));
		$e->setReading($this->computeReading($this->titleFor($fieldsJson, $data)));
		$e->setSort((int)($rec['sort'] ?? ($this->records->maxSort($cid) + 1)));
		$e->setCreatedAt((string)($rec['createdAt'] ?? $this->now()));
		$e->setUpdatedAt($this->now());
		$this->records->insert($e);
		return $cid;
	}

	/** Insert field rows exactly as captured (keys/sort/flags preserved). */
	private function restoreFields(int $cid, array $fields): void {
		foreach ($fields as $f) {
			if (!is_array($f)) {
				continue;
			}
			$e = new FieldEntity();
			$e->setCollectionId($cid);
			$e->setFieldKey((string)($f['key'] ?? ''));
			$e->setLabel((string)($f['label'] ?? ''));
			$e->setType((string)($f['type'] ?? 'text'));
			$e->setOptions(!empty($f['options']) ? json_encode($f['options']) : null);
			$e->setRequired(!empty($f['required']));
			$e->setSecret(!empty($f['secret']));
			$e->setIsTitle(!empty($f['is_title']));
			$e->setListShow(array_key_exists('list_show', $f) ? (bool)$f['list_show'] : true);
			$e->setTableShow(array_key_exists('table_show', $f) ? (bool)$f['table_show'] : true);
			$e->setCardShow(array_key_exists('card_show', $f) ? (bool)$f['card_show'] : true);
			$e->setPlaceholder($f['placeholder'] ?? null);
			$e->setSort((int)($f['sort'] ?? 0));
			$e->setConcat((int)($f['concat'] ?? 0));
			$e->setConcatSep(in_array($f['concat_sep'] ?? 'space', self::CONCAT_SEPS, true) ? (string)$f['concat_sep'] : 'space');
			$e->setConcatSepChar(mb_substr((string)($f['concat_sep_char'] ?? ''), 0, 4));
			$this->fields->insert($e);
		}
	}

	private function restoreCollectionSettings(int $id, array $s): ?int {
		try {
			$c = $this->collections->findById($id);
		} catch (DoesNotExistException $e) {
			return null;
		}
		if (isset($s['name'])) {
			$c->setName((string)$s['name']);
		}
		if (isset($s['icon'])) {
			$c->setIcon((string)$s['icon']);
		}
		if (isset($s['color'])) {
			$c->setColor((string)$s['color']);
		}
		if (array_key_exists('description', $s)) {
			$c->setDescription((string)($s['description'] ?? ''));
		}
		if (isset($s['view'])) {
			$c->setView((string)$s['view']);
		}
		if (isset($s['record_sort'])) {
			$c->setRecordSort((string)$s['record_sort']);
		}
		if (array_key_exists('locked', $s)) {
			$c->setLocked((bool)$s['locked']);
		}
		if (array_key_exists('key_head', $s)) {
			$c->setKeyHead((bool)$s['key_head']);
		}
		if (isset($s['key_sep'])) {
			$c->setKeySep((string)$s['key_sep']);
		}
		if (array_key_exists('key_sep_char', $s)) {
			$c->setKeySepChar((string)($s['key_sep_char'] ?? ''));
		}
		$c->setUpdatedAt($this->now());
		$this->collections->update($c);
		return $id;
	}

	private function recreateCollection(string $userId, array $dump): ?int {
		$s = is_array($dump['settings'] ?? null) ? $dump['settings'] : [];
		$c = new CollectionEntity();
		$c->setUserId($userId);
		$c->setName((string)($s['name'] ?? 'RegiBase'));
		$c->setIcon((string)($s['icon'] ?? '📁'));
		$c->setColor((string)($s['color'] ?? '#3b82f6'));
		$c->setDescription((string)($s['description'] ?? ''));
		$c->setView((string)($s['view'] ?? 'table'));
		$c->setRecordSort((string)($s['record_sort'] ?? 'created_desc'));
		$c->setLocked(!empty($s['locked']));
		$c->setKeyHead(!empty($s['key_head']));
		$c->setKeySep((string)($s['key_sep'] ?? 'space'));
		$c->setKeySepChar((string)($s['key_sep_char'] ?? ''));
		$c->setSort($this->collections->maxSort($userId) + 1);
		$c->setCreatedAt($this->now());
		$c->setUpdatedAt($this->now());
		$c = $this->collections->insert($c);
		$nid = (int)$c->getId();
		$this->restoreFields($nid, is_array($dump['fields'] ?? null) ? $dump['fields'] : []);
		$data = array_map(fn ($r) => is_array($r['data'] ?? null) ? $r['data'] : [], is_array($dump['records'] ?? null) ? $dump['records'] : []);
		if ($data) {
			$this->bulkInsertRecords($nid, $data);
		}
		return $nid;
	}

	public function replaceFields(string $userId, int $id, array $fields, ?string $grp = null): array {
		$this->assertEditable($this->collections->findForUser($id, $userId)); // ownership + not locked
		$oldFields = array_map(fn (FieldEntity $f) => $f->jsonSerialize(), $this->fields->findForCollection($id));
		$this->rec($userId, 'fields.replace', $id, $this->l->t('Edit fields'), ['kind' => 'restore_fields', 'collectionId' => $id, 'fields' => $oldFields], $grp);
		$this->fields->deleteForCollection($id);
		$this->insertFields($id, $fields);
		return $this->getCollection($userId, $id);
	}

	private function insertFields(int $collectionId, array $fields): void {
		$i = 0;
		$hasTitle = false;
		foreach ($fields as $f) {
			if (!empty($f['is_title'])) {
				$hasTitle = true;
			}
		}
		$seenKeys = [];
		foreach ($fields as $idx => $f) {
			// Guarantee a unique field key regardless of what the caller sent.
			// Duplicate keys make several fields share one form binding (editing
			// one writes them all), so any collision — from the client, a CSV/JSON
			// import, or a restore — is resolved here at the single write chokepoint.
			$key = trim((string)($f['key'] ?? ''));
			if ($key === '') {
				$key = 'f_' . $idx;
			}
			if (isset($seenKeys[$key])) {
				$n = 2;
				while (isset($seenKeys[$key . '_' . $n])) {
					$n++;
				}
				$key = $key . '_' . $n;
			}
			$seenKeys[$key] = true;
			$e = new FieldEntity();
			$e->setCollectionId($collectionId);
			$e->setFieldKey($key);
			$e->setLabel((string)($f['label'] ?? ''));
			$e->setType((string)($f['type'] ?? 'text'));
			$e->setOptions(!empty($f['options']) ? json_encode($f['options']) : null);
			$e->setRequired(!empty($f['required']));
			$e->setSecret(!empty($f['secret']));
			$e->setIsTitle(!$hasTitle && $idx === 0 ? true : !empty($f['is_title']));
			$e->setListShow(array_key_exists('list_show', $f) ? (bool)$f['list_show'] : true);
			$e->setTableShow(array_key_exists('table_show', $f) ? (bool)$f['table_show'] : true);
			$e->setCardShow(array_key_exists('card_show', $f) ? (bool)$f['card_show'] : true);
			$e->setPlaceholder($f['placeholder'] ?? null);
			$e->setSort($idx);
			$e->setConcat((int)($f['concat'] ?? 0));
			$e->setConcatSep(in_array($f['concat_sep'] ?? 'space', self::CONCAT_SEPS, true) ? (string)$f['concat_sep'] : 'space');
			$e->setConcatSepChar(mb_substr((string)($f['concat_sep_char'] ?? ''), 0, 4));
			$this->fields->insert($e);
		}
	}

	// ---- records ----
	/** Resolve a collection's key-separator setting to the actual join string. */
	private function keySep(CollectionEntity $c): string {
		switch ($c->getKeySep()) {
			case 'none': return '';
			case 'fullspace': return '　';
			case 'custom': return (string)$c->getKeySepChar();
			case 'space':
			default: return ' ';
		}
	}

	private function titleFor(array $fields, array $data, string $sep = ' '): string {
		// One or more fields may be flagged as the title (key). When several are,
		// their values are joined in field order (e.g. first name + last name) with
		// the collection's chosen separator, skipping any that are empty — so a
		// missing part does not leave a dangling separator.
		$parts = [];
		foreach ($fields as $f) {
			if (($f['is_title'] ?? false) && !empty($data[$f['key']])) {
				$parts[] = (string)$data[$f['key']];
			}
		}
		if ($parts) {
			return implode($sep, $parts);
		}
		foreach ($fields as $f) {
			if (!empty($data[$f['key']])) {
				return (string)$data[$f['key']];
			}
		}
		return $this->l->t('(untitled)');
	}

	private function computeReading(string $title): string {
		// NOTE: furigana auto-generation (kuromoji/MeCab) is not yet ported to PHP.
		// For now normalise the title: katakana -> hiragana, lowercase ASCII.
		$s = trim($title);
		if ($s === '') {
			return '';
		}
		if (function_exists('mb_convert_kana')) {
			$s = mb_convert_kana($s, 'c'); // katakana -> hiragana
		}
		return function_exists('mb_strtolower') ? mb_strtolower($s) : strtolower($s);
	}

	public function listRecords(string $userId, int $collectionId, ?string $q, ?string $sort, bool $regex = false): array {
		[$c] = $this->resolve($userId, $collectionId); // any recipient level may read
		$fieldsJson = array_map(fn (FieldEntity $f) => $f->jsonSerialize(), $this->fields->findForCollection($collectionId));
		$mode = ($sort && in_array($sort, self::ALLOWED_SORTS, true)) ? $sort : $c->getRecordSort();

		$sep = $this->keySep($c);
		$rows = [];
		foreach ($this->records->findForCollection($collectionId) as $r) {
			$j = $r->jsonSerialize();
			$j['title'] = $this->titleFor($fieldsJson, $j['data'], $sep);
			$rows[] = $j;
		}

		if ($q !== null && trim($q) !== '') {
			if ($regex) {
				// Build a case-sensitive PCRE from the user's pattern. On an invalid
				// pattern, leave the rows unfiltered (the client flags it too).
				$re = '~' . str_replace('~', '\\~', $q) . '~u';
				if (@preg_match($re, '') !== false) {
					$rows = array_values(array_filter($rows, function ($r) use ($re) {
						$subject = (string)$r['title'];
						foreach ((array)$r['data'] as $v) {
							$subject .= "\n" . (is_scalar($v) ? (string)$v : json_encode($v, JSON_UNESCAPED_UNICODE));
						}
						return (bool)preg_match($re, $subject);
					}));
				}
			} else {
				$needle = mb_strtolower(trim($q));
				$rows = array_values(array_filter($rows, function ($r) use ($needle) {
					return str_contains(mb_strtolower($r['title']), $needle)
						|| str_contains(mb_strtolower(json_encode($r['data'], JSON_UNESCAPED_UNICODE)), $needle);
				}));
			}
		}

		// Name sort = Unicode code-point order (language-neutral / multilingual).
		// For valid UTF-8, byte-wise strcmp() equals code-point order.
		$cmpTitle = function ($a, $b) {
			$c = strcmp((string)($a['title'] ?? ''), (string)($b['title'] ?? ''));
			return $c !== 0 ? $c : ($a['id'] - $b['id']);
		};
		// Backward compat: old kana_* preferences map to the new name sort.
		if ($mode === 'kana_title' || $mode === 'kana_reading') {
			$mode = 'title_asc';
		}
		// Registration order follows the per-record `sort` position (id as tie-break),
		// so it reflects any manual drag / sort-by-field reordering the user applied.
		$cmpPos = fn ($a, $b) => ($a['sort'] <=> $b['sort']) ?: ($a['id'] - $b['id']);
		switch ($mode) {
			case 'created_asc': usort($rows, $cmpPos); break;
			case 'title_asc': usort($rows, $cmpTitle); break;
			case 'title_desc': usort($rows, fn ($a, $b) => -$cmpTitle($a, $b)); break;
			case 'created_desc':
			default: usort($rows, fn ($a, $b) => -$cmpPos($a, $b)); break;
		}
		return $rows;
	}

	private function collectionOfRecord(string $userId, int $recordId): array {
		$r = $this->records->find($recordId);
		[$c] = $this->resolve($userId, (int)$r->getCollectionId()); // owner or share recipient
		return [$r, $c];
	}

	/** Like collectionOfRecord() but require at least $min permission. */
	private function recordWithPerm(string $userId, int $recordId, string $min): array {
		$r = $this->records->find($recordId);
		[$c] = $this->require($userId, (int)$r->getCollectionId(), $min);
		return [$r, $c];
	}

	public function getRecord(string $userId, int $id): array {
		[$r, $c] = $this->collectionOfRecord($userId, $id);
		$fieldsJson = array_map(fn (FieldEntity $f) => $f->jsonSerialize(), $this->fields->findForCollection((int)$c->getId()));
		$j = $r->jsonSerialize();
		$j['title'] = $this->titleFor($fieldsJson, $j['data'], $this->keySep($c));
		return $j;
	}

	public function createRecord(string $userId, int $collectionId, array $data): array {
		$this->requireEditable($userId, $collectionId, self::PERM_EDIT);
		$fieldsJson = array_map(fn (FieldEntity $f) => $f->jsonSerialize(), $this->fields->findForCollection($collectionId));
		$e = new RecordEntity();
		$e->setCollectionId($collectionId);
		$e->setData(json_encode($data ?: new \stdClass(), JSON_UNESCAPED_UNICODE));
		$e->setReading($this->computeReading($this->titleFor($fieldsJson, $data)));
		$e->setSort($this->records->maxSort($collectionId) + 1);
		$e->setCreatedAt($this->now());
		$e->setUpdatedAt($this->now());
		$e = $this->records->insert($e);
		$this->rec($userId, 'record.create', $collectionId, $this->l->t('Added: %s', [$this->titleFor($fieldsJson, $data)]), ['kind' => 'del_record', 'id' => (int)$e->getId()]);
		return $this->getRecord($userId, (int)$e->getId());
	}

	public function updateRecord(string $userId, int $id, array $data, ?string $grp = null, bool $noHistory = false): array {
		[$r, $c] = $this->recordWithPerm($userId, $id, self::PERM_EDIT);
		$this->assertEditable($c);
		$fieldsJson = array_map(fn (FieldEntity $f) => $f->jsonSerialize(), $this->fields->findForCollection((int)$c->getId()));
		$oldData = json_decode($r->getData() ?: '{}', true) ?: [];
		// Silent updates (automatic re-encryption of secret fields) are not user
		// edits and must not enter the snapshot history — undoing one would revert
		// the encryption and expose the plaintext.
		if (!$noHistory) {
			$this->rec($userId, 'record.update', (int)$c->getId(), $this->l->t('Edited: %s', [$this->titleFor($fieldsJson, $data)]), ['kind' => 'set_data', 'id' => $id, 'data' => $oldData], $grp);
		}
		$r->setData(json_encode($data ?: new \stdClass(), JSON_UNESCAPED_UNICODE));
		$r->setReading($this->computeReading($this->titleFor($fieldsJson, $data)));
		$r->setUpdatedAt($this->now());
		$this->records->update($r);
		// trash attachments that were replaced or cleared by this edit
		foreach ($fieldsJson as $f) {
			if (in_array($f['type'], self::ATTACH_TYPES, true)) {
				$old = $oldData[$f['key']] ?? '';
				$new = $data[$f['key']] ?? '';
				if ($old !== '' && (string)$old !== (string)$new) {
					$this->images->trashIfOwned($userId, (string)$old);
				}
			}
		}
		return $this->getRecord($userId, $id);
	}

	/**
	 * Update many records of one collection in a single call (used by find & replace).
	 * The collection is permission-checked once and its fields loaded once, so this is
	 * dramatically faster than one HTTP PUT per record. All edits share $grp for undo.
	 * @param array $updates list of ['id' => int, 'data' => array]
	 * @return int number of records actually updated
	 */
	public function bulkUpdateRecords(string $userId, int $collectionId, array $updates, ?string $grp = null): int {
		$this->requireEditable($userId, $collectionId, self::PERM_EDIT); // owner/edit + not locked
		$fieldsJson = array_map(fn (FieldEntity $f) => $f->jsonSerialize(), $this->fields->findForCollection($collectionId));
		$attach = array_values(array_filter($fieldsJson, fn ($f) => in_array($f['type'], self::ATTACH_TYPES, true)));
		$now = $this->now();
		$n = 0;
		foreach ($updates as $u) {
			$id = (int)($u['id'] ?? 0);
			if ($id <= 0) {
				continue;
			}
			$data = (isset($u['data']) && is_array($u['data'])) ? $u['data'] : [];
			try {
				$r = $this->records->find($id);
			} catch (DoesNotExistException $e) {
				continue;
			}
			if ((int)$r->getCollectionId() !== $collectionId) {
				continue; // never touch a record outside the authorised collection
			}
			$oldData = json_decode($r->getData() ?: '{}', true) ?: [];
			$this->rec($userId, 'record.update', $collectionId, $this->l->t('Edited: %s', [$this->titleFor($fieldsJson, $data)]), ['kind' => 'set_data', 'id' => $id, 'data' => $oldData], $grp);
			$r->setData(json_encode($data ?: new \stdClass(), JSON_UNESCAPED_UNICODE));
			$r->setReading($this->computeReading($this->titleFor($fieldsJson, $data)));
			$r->setUpdatedAt($now);
			$this->records->update($r);
			foreach ($attach as $f) {
				$old = $oldData[$f['key']] ?? '';
				$new = $data[$f['key']] ?? '';
				if ($old !== '' && (string)$old !== (string)$new) {
					$this->images->trashIfOwned($userId, (string)$old);
				}
			}
			$n++;
		}
		return $n;
	}

	/** Permission-checked delete that returns the data needed to re-create it (for undo). */
	private function deleteRecordCapture(string $userId, int $id): array {
		[$r, $c] = $this->recordWithPerm($userId, $id, self::PERM_DELETE);
		$this->assertEditable($c);
		$data = json_decode($r->getData() ?: '{}', true) ?: [];
		$this->trashDataAttachments($userId, $this->attachmentFields((int)$c->getId()), $data);
		$snap = ['collectionId' => (int)$c->getId(), 'data' => $data, 'sort' => (int)$r->getSort(), 'createdAt' => (string)$r->getCreatedAt()];
		$this->records->delete($r);
		return $snap;
	}

	public function deleteRecord(string $userId, int $id): void {
		$snap = $this->deleteRecordCapture($userId, $id);
		$fj = array_map(fn (FieldEntity $f) => $f->jsonSerialize(), $this->fields->findForCollection((int)$snap['collectionId']));
		$this->rec($userId, 'record.delete', $snap['collectionId'], $this->l->t('Deleted: %s', [$this->titleFor($fj, $snap['data'])]), ['kind' => 'reinsert', 'record' => $snap]);
	}

	public function deleteRecords(string $userId, array $ids): int {
		$snaps = [];
		$cid = null;
		foreach ($ids as $id) {
			try {
				$s = $this->deleteRecordCapture($userId, (int)$id);
				$snaps[] = $s;
				$cid = $s['collectionId'];
			} catch (DoesNotExistException | ForbiddenException $e) {
				// skip records the user cannot delete
			}
		}
		if ($snaps) {
			$this->rec($userId, 'record.delete_many', $cid, $this->l->t('Delete %s records', [count($snaps)]), ['kind' => 'reinsert_many', 'records' => $snaps]);
		}
		return count($snaps);
	}

	/**
	 * Reassign the registration order (`sort` position) of a collection's records
	 * to match the given id order (position 1..N). Edit permission required. Ids
	 * that don't belong to the collection are ignored; any records omitted from
	 * $orderedIds keep their current relative order, appended after the listed ones.
	 * @return int number of records whose position actually changed
	 */
	public function reorderRecords(string $userId, int $collectionId, array $orderedIds): int {
		$this->requireEditable($userId, $collectionId, self::PERM_EDIT);
		$records = $this->records->findForCollection($collectionId);
		$byId = [];
		$prevOrder = [];
		foreach ($records as $r) {
			$byId[(int)$r->getId()] = $r;
			$prevOrder[] = [(int)$r->getId(), (int)$r->getSort()];
		}
		$this->rec($userId, 'record.reorder', $collectionId, $this->l->t('Change record order'), ['kind' => 'reorder', 'orders' => $prevOrder]);

		$seen = [];
		$sequence = [];
		foreach ($orderedIds as $id) {
			$id = (int)$id;
			if (isset($byId[$id]) && !isset($seen[$id])) {
				$sequence[] = $byId[$id];
				$seen[$id] = true;
			}
		}
		// records not mentioned in the payload keep their existing order, at the end
		foreach ($records as $r) {
			$id = (int)$r->getId();
			if (!isset($seen[$id])) {
				$sequence[] = $r;
				$seen[$id] = true;
			}
		}

		$pos = 0;
		$changed = 0;
		foreach ($sequence as $r) {
			$pos++;
			if ((int)$r->getSort() !== $pos) {
				$r->setSort($pos);
				$this->records->update($r);
				$changed++;
			}
		}
		return $changed;
	}

	// ---- fields (append) ----
	/**
	 * Append new fields to a collection (used by transfer "add as new field").
	 * Skips keys that already exist; forces is_title=false. Returns keys added.
	 */
	public function appendFields(string $userId, int $collectionId, array $fields): array {
		$this->assertEditable($this->collections->findForUser($collectionId, $userId)); // ownership + not locked
		$existingFields = $this->fields->findForCollection($collectionId);
		$this->rec($userId, 'fields.append', $collectionId, $this->l->t('Add fields'), ['kind' => 'restore_fields', 'collectionId' => $collectionId, 'fields' => array_map(fn (FieldEntity $f) => $f->jsonSerialize(), $existingFields)]);
		$existing = [];
		$maxSort = 0;
		foreach ($existingFields as $f) {
			$existing[$f->getFieldKey()] = true;
			$maxSort = max($maxSort, $f->getSort());
		}
		$added = [];
		$i = 1;
		foreach ($fields as $f) {
			$key = (string)($f['key'] ?? '');
			if ($key === '' || isset($existing[$key])) {
				continue;
			}
			$e = new FieldEntity();
			$e->setCollectionId($collectionId);
			$e->setFieldKey($key);
			$e->setLabel((string)($f['label'] ?? ''));
			$e->setType((string)($f['type'] ?? 'text'));
			$e->setOptions(!empty($f['options']) ? json_encode($f['options']) : null);
			$e->setRequired(!empty($f['required']));
			$e->setSecret(!empty($f['secret']));
			$e->setIsTitle(false);
			$e->setListShow(array_key_exists('list_show', $f) ? (bool)$f['list_show'] : true);
			$e->setTableShow(array_key_exists('table_show', $f) ? (bool)$f['table_show'] : true);
			$e->setCardShow(array_key_exists('card_show', $f) ? (bool)$f['card_show'] : true);
			$e->setPlaceholder($f['placeholder'] ?? null);
			$e->setSort($maxSort + $i);
			$this->fields->insert($e);
			$existing[$key] = true;
			$added[] = $key;
			$i++;
		}
		return $added;
	}

	// ---- bulk insert ----
	/** Insert many records into a collection (ownership already checked). */
	private function bulkInsertRecords(int $collectionId, array $dataArray): int {
		return count($this->bulkInsertRecordsIds($collectionId, $dataArray));
	}

	/** Like bulkInsertRecords() but returns the ids of the inserted records (for undo). */
	private function bulkInsertRecordsIds(int $collectionId, array $dataArray): array {
		$fieldsJson = array_map(fn (FieldEntity $f) => $f->jsonSerialize(), $this->fields->findForCollection($collectionId));
		$ts = $this->now();
		$sort = $this->records->maxSort($collectionId);
		$ids = [];
		foreach ($dataArray as $data) {
			$data = is_array($data) ? $data : [];
			$e = new RecordEntity();
			$e->setCollectionId($collectionId);
			$e->setData(json_encode($data ?: new \stdClass(), JSON_UNESCAPED_UNICODE));
			$e->setReading($this->computeReading($this->titleFor($fieldsJson, $data)));
			$e->setSort(++$sort);
			$e->setCreatedAt($ts);
			$e->setUpdatedAt($ts);
			$e = $this->records->insert($e);
			$ids[] = (int)$e->getId();
		}
		return $ids;
	}

	// ---- transfer (move/copy between collections) ----
	/** Map a source record's data onto the target collection's field keys. */
	private function mapData(array $sourceData, array $cleanMapping, ?string $appendTo, array $sourceFields): array {
		$td = [];
		$used = [];
		foreach ($cleanMapping as $sk => $tk) {
			$v = $sourceData[$sk] ?? null;
			if ($v === null || $v === '') {
				continue;
			}
			$td[$tk] = isset($td[$tk]) ? ($td[$tk] . "\n" . $v) : $v; // collision -> concatenate
			$used[$sk] = true;
		}
		if ($appendTo) {
			$lines = [];
			foreach ($sourceFields as $f) {
				$k = $f['key'];
				if (isset($used[$k])) {
					continue;
				}
				$v = $sourceData[$k] ?? null;
				if ($v === null || $v === '') {
					continue;
				}
				$lines[] = $f['label'] . ': ' . $v;
			}
			if (count($lines) > 0) {
				$cur = $td[$appendTo] ?? '';
				$td[$appendTo] = ($cur !== '' ? $cur . "\n" : '') . implode("\n", $lines);
			}
		}
		return $td;
	}

	/**
	 * Move or copy records to another collection, remapping fields.
	 * @return array{count: int}
	 */
	public function transferRecords(string $userId, array $opts): array {
		$sourceId = (int)($opts['sourceCollectionId'] ?? 0);
		$targetId = (int)($opts['targetCollectionId'] ?? 0);
		$mode = ($opts['mode'] ?? 'copy') === 'move' ? 'move' : 'copy';
		$recordIds = $opts['recordIds'] ?? [];
		if (!is_array($recordIds) || count($recordIds) === 0) {
			throw new \RuntimeException('recordIds is required');
		}

		$srcEntity = $this->collections->findForUser($sourceId, $userId); // transfer is owner-only (both sides)
		$source = $this->getCollection($userId, $sourceId); // fields
		$tgtEntity = $this->collections->findForUser($targetId, $userId); // ownership of target
		$this->assertEditable($tgtEntity); // target is always written to
		if ($mode === 'move') {
			$this->assertEditable($srcEntity); // move also deletes from the source
		}

		if (!empty($opts['addFields']) && is_array($opts['addFields'])) {
			$this->appendFields($userId, $targetId, $opts['addFields']);
		}
		$target = $this->getCollection($userId, $targetId);

		$targetKeys = [];
		foreach ($target['fields'] as $f) {
			$targetKeys[$f['key']] = true;
		}
		$cleanMapping = [];
		foreach (($opts['mapping'] ?? []) as $sk => $tk) {
			if ($tk && isset($targetKeys[$tk])) {
				$cleanMapping[$sk] = $tk;
			}
		}
		$appendTo = (!empty($opts['appendUnmappedTo']) && isset($targetKeys[$opts['appendUnmappedTo']]))
			? (string)$opts['appendUnmappedTo'] : null;

		$mapped = [];
		$moveIds = [];
		foreach ($recordIds as $rid) {
			try {
				$r = $this->records->find((int)$rid);
			} catch (DoesNotExistException $e) {
				continue;
			}
			if ((int)$r->getCollectionId() !== $sourceId) {
				continue; // not from the source collection -> skip (ownership already checked)
			}
			$sourceData = json_decode($r->getData() ?: '{}', true) ?: [];
			$mapped[] = $this->mapData($sourceData, $cleanMapping, $appendTo, $source['fields']);
			$moveIds[] = (int)$r->getId();
		}

		$createdIds = $this->bulkInsertRecordsIds($targetId, $mapped);
		$movedBack = [];
		if ($mode === 'move') {
			foreach ($moveIds as $mid) {
				try {
					$r = $this->records->find($mid);
					$movedBack[] = ['collectionId' => $sourceId, 'data' => json_decode($r->getData() ?: '{}', true) ?: [], 'sort' => (int)$r->getSort(), 'createdAt' => (string)$r->getCreatedAt()];
					$this->records->delete($r);
				} catch (DoesNotExistException $e) {
					// skip
				}
			}
		}
		$this->rec($userId, 'record.transfer', $targetId,
			$mode === 'move' ? $this->l->t('Move %s records', [count($createdIds)]) : $this->l->t('Copy %s records', [count($createdIds)]),
			['kind' => 'undo_transfer', 'createdIds' => $createdIds, 'restore' => $movedBack]);
		return ['count' => count($createdIds)];
	}

	// ---- CSV import ----
	/** @return array{collectionId: int, imported: int} */
	public function importCommit(string $userId, string $csv, array $collectionMeta, array $columns, ?IL10N $l = null): array {
		$l = $l ?? $this->l;
		$built = DataImport::buildRecords($csv, $columns);
		$c = $this->createCollection($userId, [
			'name' => $collectionMeta['name'] ?? $l->t('Imported data'),
			'icon' => $collectionMeta['icon'] ?? '📥',
			'color' => $collectionMeta['color'] ?? '#0ea5e9',
			'fields' => $built['fields'],
		], $l);
		$imported = $this->bulkInsertRecords((int)$c['id'], $built['records']);
		return ['collectionId' => (int)$c['id'], 'imported' => $imported];
	}

	// ---- export ----
	private function sanitizeFilename(string $name): string {
		$name = str_replace(['/', '\\', "\0", ':', '*', '?', '"', '<', '>', '|'], '-', $name);
		$name = trim($name, " \t.");
		return $name !== '' ? mb_substr($name, 0, 120) : 'collection';
	}

	private function csvCell($v): string {
		$s = (string)$v;
		if (preg_match('/["\r\n,]/', $s)) {
			$s = '"' . str_replace('"', '""', $s) . '"';
		}
		return $s;
	}

	/**
	 * Export a collection as CSV or JSON.
	 * @return array{filename: string, mime: string, content: string}
	 */
	public function exportCollection(string $userId, int $id, string $format): array {
		[$c] = $this->resolve($userId, $id); // owner or any share recipient may export
		$fields = array_map(fn (FieldEntity $f) => $f->jsonSerialize(), $this->fields->findForCollection($id));
		$rows = [];
		foreach ($this->records->findForCollection($id) as $r) {
			$j = $r->jsonSerialize();
			$rows[] = $j;
		}
		usort($rows, fn ($a, $b) => $a['id'] - $b['id']);
		$base = $this->sanitizeFilename($c->getName());

		if ($format === 'json') {
			$obj = [
				'app' => 'RegiBase',
				'version' => 1,
				'collection' => [
					'name' => $c->getName(),
					'icon' => $c->getIcon(),
					'color' => $c->getColor(),
					'description' => $c->getDescription() ?? '',
					'view' => $c->getView(),
					'record_sort' => $c->getRecordSort(),
					'key_head' => $c->getKeyHead(),
					'key_sep' => $c->getKeySep(),
					'key_sep_char' => $c->getKeySepChar(),
				],
				'fields' => $fields,
				'records' => array_map(fn ($r) => $r['data'], $rows),
			];
			return [
				'filename' => $base . '.json',
				'mime' => 'application/json; charset=UTF-8',
				'content' => json_encode($obj, JSON_UNESCAPED_UNICODE | JSON_PRETTY_PRINT),
			];
		}

		// CSV: header row of field labels, then one row per record.
		$lines = [];
		$lines[] = implode(',', array_map(fn ($f) => $this->csvCell($f['label']), $fields));
		foreach ($rows as $r) {
			$cells = [];
			foreach ($fields as $f) {
				$cells[] = $this->csvCell($r['data'][$f['key']] ?? '');
			}
			$lines[] = implode(',', $cells);
		}
		$content = "\xEF\xBB\xBF" . implode("\r\n", $lines) . "\r\n"; // BOM for Excel
		return [
			'filename' => $base . '.csv',
			'mime' => 'text/csv; charset=UTF-8',
			'content' => $content,
		];
	}

	// ---- full backup / restore ----

	/**
	 * Everything needed to reconstruct the user's RegiBase data.
	 * @return array{struct: array, attachmentIds: string[]}
	 */
	public function exportAll(string $userId): array {
		$collections = [];
		$attachmentIds = [];
		foreach ($this->collections->findAllForUser($userId) as $c) {
			$cid = (int)$c->getId();
			$fieldsJson = array_map(fn (FieldEntity $f) => $f->jsonSerialize(), $this->fields->findForCollection($cid));
			$attachKeys = array_values(array_filter($fieldsJson, fn ($f) => in_array($f['type'], self::ATTACH_TYPES, true)));
			$records = [];
			foreach ($this->records->findForCollection($cid) as $r) {
				$j = $r->jsonSerialize();
				$data = is_array($j['data'] ?? null) ? $j['data'] : [];
				foreach ($attachKeys as $f) {
					$v = $data[$f['key']] ?? '';
					if ($v !== '' && $v !== null && preg_match('/^\d+$/', (string)$v)) {
						$attachmentIds[(string)$v] = true;
					}
				}
				$records[] = ['data' => $data];
			}
			$cj = $c->jsonSerialize();
			$collections[] = [
				'name' => $cj['name'] ?? '',
				'icon' => $cj['icon'] ?? '📁',
				'color' => $cj['color'] ?? '#3b82f6',
				'description' => $cj['description'] ?? '',
				'view' => $cj['view'] ?? 'list',
				'record_sort' => $cj['record_sort'] ?? 'created_desc',
				'key_head' => $cj['key_head'] ?? false,
				'key_sep' => $cj['key_sep'] ?? 'space',
				'key_sep_char' => $cj['key_sep_char'] ?? '',
				'fields' => $fieldsJson,
				'records' => $records,
			];
		}
		return [
			'struct' => ['app' => 'RegiBase', 'backup_version' => 1, 'exported_at' => $this->now(), 'collections' => $collections],
			'attachmentIds' => array_keys($attachmentIds),
		];
	}

	/**
	 * Replace ALL of the user's collections/records with the backup's contents.
	 * $fileIdMap maps old attachment fileIds → freshly restored fileIds.
	 * $mode: 'overwrite' (wipe then restore) | 'merge' (add only non-duplicate
	 * records into same-name collections) | 'add' (always create new collections).
	 * @return array{collections: int, records: int, mode: string}
	 */
	public function importAll(string $userId, array $struct, array $fileIdMap, string $mode = 'overwrite'): array {
		if (!in_array($mode, ['overwrite', 'merge', 'add'], true)) {
			$mode = 'overwrite';
		}
		if ($mode === 'overwrite') {
			foreach ($this->collections->findAllForUser($userId) as $c) {
				$this->deleteCollection($userId, (int)$c->getId());
			}
		}

		// For merge: index existing collections by name + the signatures of their records.
		$existingByName = [];
		if ($mode === 'merge') {
			foreach ($this->collections->findAllForUser($userId) as $c) {
				$cid = (int)$c->getId();
				$fieldsJson = array_map(fn (FieldEntity $f) => $f->jsonSerialize(), $this->fields->findForCollection($cid));
				$attachKeys = $this->attachmentKeys($fieldsJson);
				$sigs = [];
				foreach ($this->records->findForCollection($cid) as $r) {
					$rd = $r->jsonSerialize();
					$sigs[$this->recordSignature(is_array($rd['data'] ?? null) ? $rd['data'] : [], $attachKeys)] = true;
				}
				$name = (string)$c->getName();
				if (!isset($existingByName[$name])) {
					$existingByName[$name] = ['id' => $cid, 'sigs' => $sigs];
				}
			}
		}

		$colCount = 0;
		$recCount = 0;
		foreach (($struct['collections'] ?? []) as $col) {
			$fields = is_array($col['fields'] ?? null) ? $col['fields'] : [];
			$attachKeys = $this->attachmentKeys($fields);
			$name = (string)($col['name'] ?? 'RegiBase');

			if ($mode === 'merge' && isset($existingByName[$name])) {
				$cid = $existingByName[$name]['id'];
				$dataArray = [];
				foreach (($col['records'] ?? []) as $rec) {
					$data = $this->remapAttachments(is_array($rec['data'] ?? null) ? $rec['data'] : [], $attachKeys, $fileIdMap);
					$sig = $this->recordSignature($data, $attachKeys);
					if (isset($existingByName[$name]['sigs'][$sig])) {
						continue; // duplicate → skip
					}
					$existingByName[$name]['sigs'][$sig] = true;
					$dataArray[] = $data;
				}
				$recCount += $this->bulkInsertRecords($cid, $dataArray);
				continue;
			}

			// overwrite / add / merge-with-no-matching-collection → create a new collection
			$created = $this->createCollection($userId, [
				'name' => $name,
				'icon' => $col['icon'] ?? '📁',
				'color' => $col['color'] ?? '#3b82f6',
				'description' => $col['description'] ?? '',
				'view' => $col['view'] ?? 'list',
				'key_head' => $col['key_head'] ?? false,
				'key_sep' => $col['key_sep'] ?? 'space',
				'key_sep_char' => $col['key_sep_char'] ?? '',
				'fields' => $fields,
			]);
			$cid = (int)$created['id'];
			$dataArray = [];
			foreach (($col['records'] ?? []) as $rec) {
				$dataArray[] = $this->remapAttachments(is_array($rec['data'] ?? null) ? $rec['data'] : [], $attachKeys, $fileIdMap);
			}
			$recCount += $this->bulkInsertRecords($cid, $dataArray);
			$colCount++;
		}
		return ['collections' => $colCount, 'records' => $recCount, 'mode' => $mode];
	}

	/** Insert many records (from data arrays) into a collection the user owns. */
	public function bulkAddRecords(string $userId, int $collectionId, array $dataArray): int {
		$this->assertEditable($this->collections->findForUser($collectionId, $userId)); // owner + not locked
		$ids = $this->bulkInsertRecordsIds($collectionId, $dataArray);
		if ($ids) {
			$this->rec($userId, 'record.bulk_add', $collectionId, $this->l->t('Import %s records', [count($ids)]), ['kind' => 'del_many', 'ids' => $ids]);
		}
		return count($ids);
	}

	// ---- shares (internal sharing between users) ----

	/** List a collection's shares (owner only). @return array[] */
	public function listShares(string $ownerUid, int $collectionId): array {
		$this->collections->findForUser($collectionId, $ownerUid); // owner only
		return array_map(fn (ShareEntity $s) => $s->jsonSerialize(), $this->shares->findForCollection($collectionId));
	}

	/**
	 * Share a collection with another user or a whole group (owner only).
	 * $recipientType: 'user' | 'group'.
	 * $encKey/$encSalt: the owner's key wrapped with the share password (optional; enables secret viewing).
	 */
	public function addShare(string $ownerUid, int $collectionId, string $recipientUid, string $perm,
		?string $password, ?string $encKey, ?string $encSalt, string $recipientType = 'user'): array {
		$this->collections->findForUser($collectionId, $ownerUid); // owner only
		$recipientType = ($recipientType === 'group') ? 'group' : 'user';
		if ($recipientType === 'user') {
			if ($recipientUid === $ownerUid) {
				throw new \RuntimeException('Cannot share with yourself');
			}
			if ($this->userManager->get($recipientUid) === null) {
				throw new \RuntimeException('No such user');
			}
		} else {
			if (!$this->groupManager->groupExists($recipientUid)) {
				throw new \RuntimeException('No such group');
			}
		}
		if (!isset(self::PERM_RANK[$perm])) {
			$perm = self::PERM_VIEW;
		}
		if ($this->shares->findOne($collectionId, $recipientUid, $recipientType) !== null) {
			throw new \RuntimeException('Already shared');
		}
		$s = new ShareEntity();
		$s->setCollectionId($collectionId);
		$s->setOwnerUid($ownerUid);
		$s->setRecipientUid($recipientUid);
		$s->setRecipientType($recipientType);
		$s->setPerm($perm);
		$s->setPwHash(($password !== null && $password !== '') ? password_hash($password, PASSWORD_DEFAULT) : null);
		$s->setEncKey(($encKey !== null && $encKey !== '') ? $encKey : null);
		$s->setEncSalt(($encSalt !== null && $encSalt !== '') ? $encSalt : null);
		$s->setCreatedAt($this->now());
		return $this->shares->insert($s)->jsonSerialize();
	}

	/** Change a share's permission / password / wrapped key (owner only). */
	public function updateShare(string $ownerUid, int $collectionId, string $recipientUid, array $patch, string $recipientType = 'user'): array {
		$this->collections->findForUser($collectionId, $ownerUid); // owner only
		$s = $this->shares->findOne($collectionId, $recipientUid, $recipientType);
		if ($s === null) {
			throw new DoesNotExistException('no such share');
		}
		if (isset($patch['perm']) && isset(self::PERM_RANK[(string)$patch['perm']])) {
			$s->setPerm((string)$patch['perm']);
		}
		if (array_key_exists('password', $patch)) {
			$p = $patch['password'];
			$s->setPwHash(($p !== null && $p !== '') ? password_hash((string)$p, PASSWORD_DEFAULT) : null);
		}
		if (array_key_exists('enc_key', $patch)) {
			$s->setEncKey($patch['enc_key'] ? (string)$patch['enc_key'] : null);
			$s->setEncSalt((isset($patch['enc_salt']) && $patch['enc_salt']) ? (string)$patch['enc_salt'] : null);
		}
		$this->shares->update($s);
		return $s->jsonSerialize();
	}

	/** Remove a share (owner only). */
	public function removeShare(string $ownerUid, int $collectionId, string $recipientUid, string $recipientType = 'user'): void {
		$this->collections->findForUser($collectionId, $ownerUid); // owner only
		$s = $this->shares->findOne($collectionId, $recipientUid, $recipientType);
		if ($s !== null) {
			$this->shares->delete($s);
		}
	}

	/**
	 * Recipient unlocks a shared collection: verify the share password (if any) and
	 * return the wrapped key material so the client can decrypt secrets.
	 * @return array{ok: bool, enc_key: ?string, enc_salt: ?string, perm: string}
	 */
	public function unlockShare(string $recipientUid, int $collectionId, string $password): array {
		$s = $this->bestShare($collectionId, $recipientUid);
		if ($s === null) {
			throw new DoesNotExistException('not shared with you');
		}
		if ($s->getPwHash() !== null && $s->getPwHash() !== '') {
			if (!password_verify($password, (string)$s->getPwHash())) {
				throw new ForbiddenException('incorrect share password');
			}
		}
		$this->markShareUnlocked($collectionId);
		return [
			'ok' => true,
			'enc_key' => $s->getEncKey(),
			'enc_salt' => $s->getEncSalt(),
			'perm' => $s->getPerm(),
		];
	}

	/** @return string[] keys of attachment-type fields */
	private function attachmentKeys(array $fieldsJson): array {
		$keys = [];
		foreach ($fieldsJson as $f) {
			if (in_array($f['type'] ?? '', self::ATTACH_TYPES, true) && ($f['key'] ?? '') !== '') {
				$keys[] = $f['key'];
			}
		}
		return $keys;
	}

	private function remapAttachments(array $data, array $attachKeys, array $fileIdMap): array {
		foreach ($attachKeys as $k) {
			$v = $data[$k] ?? '';
			if ($v !== '' && $v !== null && isset($fileIdMap[(string)$v])) {
				$data[$k] = (string)$fileIdMap[(string)$v];
			}
		}
		return $data;
	}

	/** Duplicate-detection signature: non-attachment field values, order-independent. */
	private function recordSignature(array $data, array $attachKeys): string {
		$norm = [];
		foreach ($data as $k => $v) {
			if (in_array($k, $attachKeys, true)) {
				continue;
			}
			if ($v !== '' && $v !== null) {
				$norm[(string)$k] = (string)$v;
			}
		}
		ksort($norm);
		return (string)json_encode($norm, JSON_UNESCAPED_UNICODE);
	}
}
