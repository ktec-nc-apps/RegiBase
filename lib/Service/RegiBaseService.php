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
use OCP\Share\IManager as IShareManager;

class RegiBaseService {
	private const ALLOWED_VIEWS = ['card', 'list', 'table', 'note'];
	private const ALLOWED_SORTS = ['created_asc', 'created_desc', 'title_asc', 'title_desc'];
	private const KEY_SEPS = ['none', 'space', 'fullspace', 'custom'];
	/** Field concat separators: KEY_SEPS plus 'paren' (wrap the target in （ ）). */
	public const CONCAT_SEPS = ['none', 'space', 'fullspace', 'custom', 'paren', 'parenfull'];
	private const ATTACH_TYPES = ['image', 'image_crop', 'file'];

	/**
	 * $v when it is one of $allowed, else $default. The old inline form read the key again
	 * after the "?? default": a missing key stored '' (with a PHP warning), not the default.
	 */
	private static function oneOf($v, array $allowed, string $default): string {
		return is_string($v) && in_array($v, $allowed, true) ? $v : $default;
	}
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
		private RecordVersionService $versions,
		private IUserManager $userManager,
		private IGroupManager $groupManager,
		private IShareManager $shareManager,
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
			// A share past its end date gives nothing, and its key is erased.
			if ($this->purgeIfExpired($s) || !$this->shareAllowedNow($s)) {
				continue;
			}
			$rank = self::PERM_RANK[$s->getPerm()] ?? 0;
			$isUser = $s->getRecipientType() === 'user';
			if ($best === null || $rank > $bestRank || ($rank === $bestRank && $isUser)) {
				$best = $s;
				$bestRank = $rank;
			}
		}
		return $best;
	}

	/**
	 * A share past its end date: its wrapped key is erased (owner, 2026-09-24:
	 * 「鍵は抹消する」). The row stays, so the owner still sees it and can renew it.
	 * @return bool whether the share has expired
	 */
	private function purgeIfExpired(ShareEntity $s): bool {
		if (!ShareEntity::isPast($s->getExpiresAt(), ShareEntity::ownerZone((string)$s->getOwnerUid()))) {
			return false;
		}
		if (($s->getEncKey() ?? '') !== '' || ($s->getEncSalt() ?? '') !== '') {
			$s->setEncKey(null);
			$s->setEncSalt(null);
			$this->shares->update($s);
		}
		return true;
	}

	/**
	 * Whether the administrator's sharing settings still allow this share. A share made before
	 * the settings were tightened gives nothing while they forbid it; the row and its key stay,
	 * so it works again if the settings are relaxed (owner, 2026-09-25: 案2).
	 */
	private function shareAllowedNow(ShareEntity $s): bool {
		try {
			$this->checkSharePolicy((string)$s->getOwnerUid(), (string)$s->getRecipientType(), (string)$s->getRecipientUid());
			return true;
		} catch (\RuntimeException $e) {
			return false;
		}
	}

	/** YYYY-MM-DD or null. */
	private function cleanDate($v): ?string {
		$v = trim((string)($v ?? ''));
		if ($v === '') {
			return null;
		}
		if (!preg_match('/^\d{4}-\d{2}-\d{2}$/', $v) || strtotime($v) === false) {
			throw new \RuntimeException('Invalid date');
		}
		return $v;
	}

	/** Best-effort append to the undo/change-history journal (never blocks the op). */
	private function rec(string $userId, string $op, ?int $collectionId, string $summary, array $undo, ?string $grp = null): void {
		try {
			$this->history->record($userId, $op, $collectionId, $summary, $undo, $grp);
		} catch (\Throwable $e) {
			// history is a safety net; a failure to record must not fail the action
		}
	}

	/** A hidden collection whose 6-digit key was given in this session. */
	private function secretOpen(int $collectionId): bool {
		return $this->session->get('regibase_secret_ok_' . $collectionId) === true;
	}
	private function markSecretOpen(int $collectionId): void {
		$this->session->set('regibase_secret_ok_' . $collectionId, true);
	}

	private function unlockKey(int $collectionId): string {
		return 'regibase_unlocked_' . $collectionId;
	}

	/**
	 * What an unlock is tied to: the share itself and its password. It was tied to the
	 * collection alone, so a recipient stayed unlocked after the owner changed the share
	 * password, or removed the share and made it again (review P21).
	 */
	private static function unlockMark(ShareEntity $share): string {
		return substr(hash('sha256', $share->getId() . ':' . (string)$share->getPwHash()), 0, 32);
	}

	private function isShareUnlocked(ShareEntity $share): bool {
		$v = $this->session->get($this->unlockKey((int)$share->getCollectionId()));
		return is_string($v) && hash_equals(self::unlockMark($share), $v);
	}

	private function markShareUnlocked(ShareEntity $share): void {
		$this->session->set($this->unlockKey((int)$share->getCollectionId()), self::unlockMark($share));
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
			// A hidden (secret) collection opens only after its 6-digit key was given in
			// this session: it used to be left out of the list and nothing more, and
			// asking for its id read it all (review P4).
			if ($c->getSecret() && !$this->secretOpen($id)) {
				// answered as "not found": its very existence is what is kept hidden
				throw new DoesNotExistException('no access to collection');
			}
			return [$c, 'owner', true, null];
		} catch (DoesNotExistException $e) {
			// fall through: maybe it is shared to this user
		}
		$share = $this->bestShare($id, $userId);
		if ($share === null) {
			throw new DoesNotExistException('no access to collection');
		}
		// a password-protected share must be unlocked in this session first
		if ($share->getPwHash() !== null && $share->getPwHash() !== '' && !$this->isShareUnlocked($share)) {
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

	/** Move the attachments referenced in $data that sit in the collection's folder to the trash. */
	private function trashDataAttachments(string $userId, array $attachFields, array $data, string $folder): void {
		foreach ($attachFields as $f) {
			$v = $data[$f['key']] ?? '';
			if ($v !== '' && $v !== null) {
				$this->images->trashIfOwned($userId, (string)$v, $folder);
			}
		}
	}

	/**
	 * Whose Files an attachment of collection $collectionId is read from, for $userId: the
	 * owner's, when $userId was given the collection and one of its records holds file $fileId
	 * in an attachment field; otherwise $userId's own. So the people a collection is shared
	 * with see the owner's pictures and documents (and nothing else of the owner's Files).
	 */
	public function attachmentReader(string $userId, int $collectionId, string $fileId): string {
		if ($collectionId <= 0 || !preg_match('/^\d+$/', $fileId)) {
			return $userId;
		}
		try {
			[$c, , $isOwner] = $this->require($userId, $collectionId, self::PERM_VIEW);
		} catch (\Throwable $e) {
			return $userId;
		}
		if ($isOwner) {
			return $userId;
		}
		$attach = $this->attachmentFields($collectionId);
		foreach ($this->records->findForCollection($collectionId) as $r) {
			$data = json_decode($r->getData() ?: '{}', true) ?: [];
			foreach ($attach as $f) {
				if ((string)($data[$f['key']] ?? '') === $fileId) {
					return (string)$c->getUserId();
				}
			}
		}
		return $userId;
	}

	/**
	 * Attachments of a shared collection are the owner's files: the people it is shared with
	 * may look at them and download them, but not add, replace or remove one, whatever their
	 * permission (owner's order, 2026-09-24).
	 */
	private function assertAttachmentsKept(string $userId, CollectionEntity $c, array $fieldsJson, array $new, array $old): void {
		if ((string)$c->getUserId() === $userId) {
			return;
		}
		foreach ($fieldsJson as $f) {
			if (in_array($f['type'], self::ATTACH_TYPES, true) && (string)($new[$f['key']] ?? '') !== (string)($old[$f['key']] ?? '')) {
				throw new \RuntimeException('Only the owner of the collection can change its attachments.');
			}
		}
	}

	/**
	 * A file newly put into an attachment field must be one the writer can open in their own
	 * Files: an id is only a number, and one taken from somebody else's files let an editor
	 * reach attachments of the owner's other collections (review P8). Values left as they
	 * were are not checked, so a record with somebody else's attachment can still be edited.
	 */
	private function checkAttachments(string $userId, array $fieldsJson, array $new, array $old): void {
		foreach ($fieldsJson as $f) {
			if (!in_array($f['type'], self::ATTACH_TYPES, true)) {
				continue;
			}
			$v = (string)($new[$f['key']] ?? '');
			if ($v === '' || $v === (string)($old[$f['key']] ?? '') || !preg_match('/^\d+$/', $v)) {
				continue;
			}
			if (!$this->images->canRead($userId, $v)) {
				throw new \RuntimeException('The attached file was not found in your files.');
			}
		}
	}

	private function now(): string {
		return gmdate('Y-m-d\TH:i:s\Z');
	}

	/**
	 * A record's updated_at, to the millisecond: it is what a save is checked against, and at
	 * one-second steps a save made in the same second as the one it follows went unnoticed
	 * (review J18).
	 */
	private function recordNow(): string {
		return (new \DateTimeImmutable('now', new \DateTimeZone('UTC')))->format('Y-m-d\TH:i:s.v\Z');
	}

	/**
	 * What somebody who is not the owner writes is kept to the collection's current fields:
	 * any other key keeps the value it had. An editor could store a file id under a key that
	 * later became an attachment field (the owner adding a "Photo" image field), and every
	 * recipient could then read that file of the owner (review P8).
	 */
	private function keepForeignKeys(string $userId, CollectionEntity $c, array $fieldsJson, array $new, array $old): array {
		if ((string)$c->getUserId() === $userId) {
			return $new;
		}
		$known = array_flip(array_map(static fn ($f) => (string)$f['key'], $fieldsJson));
		$out = [];
		foreach ($new as $k => $v) {
			if (isset($known[(string)$k])) {
				$out[$k] = $v;
			}
		}
		foreach ($old as $k => $v) {
			if (!isset($known[(string)$k])) {
				$out[$k] = $v;
			}
		}
		return $out;
	}

	/**
	 * Values in attachment fields that the writer cannot open in their own Files are dropped:
	 * used where data reaches an attachment field without passing checkAttachments — a field
	 * changed to an attachment type, a field change undone, records moved onto an attachment
	 * field (review P8).
	 */
	private function dropForeignAttachments(string $userId, array $fieldsJson, array $data, array $onlyKeys = []): array {
		foreach ($fieldsJson as $f) {
			$k = (string)$f['key'];
			if (!in_array($f['type'], self::ATTACH_TYPES, true) || ($onlyKeys !== [] && !isset($onlyKeys[$k])) || !array_key_exists($k, $data)) {
				continue;
			}
			$v = (string)$data[$k];
			if ($v === '') {
				continue;
			}
			if (!preg_match('/^\d+$/', $v) || !$this->images->canRead($userId, $v)) {
				unset($data[$k]);
			}
		}
		return $data;
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
			// What the recipient's page needs to check the share password without
			// sending it: the salt of the value derived from it.
			$j['auth_salt'] = $share->getAuthSalt();
			$j['expires_at'] = $share->getExpiresAt();
			// The owner's wrapped key is the owner's business only.
			unset($j['key_wrap']);
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
			// a share past its last day is not listed (and its key is erased)
			if ($this->purgeIfExpired($share) || !$this->shareAllowedNow($share)) {
				continue;
			}
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
				$this->markSecretOpen((int)$c->getId());
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
		$c->setKeySep(self::oneOf($input['key_sep'] ?? null, self::KEY_SEPS, 'space'));
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
		if ($c->getSecret()) {
			$this->markSecretOpen((int)$c->getId());   // created with its key: open for its creator
		}
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
			$newFolder = mb_substr($this->images->normalizePath((string)$patch['files_folder']), 0, 512);
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
				$this->markSecretOpen((int)$c->getId());   // the owner just gave the key
			}
		}
		if (array_key_exists('secret', $patch)) {
			if ($patch['secret']) {
				if (!$c->getSecretHash()) {
					throw new \InvalidArgumentException($this->l->t('Set a 6-digit secret key to make this collection secret.'));
				}
				$c->setSecret(true);
				$this->markSecretOpen((int)$c->getId());
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

	public function deleteCollection(string $userId, int $id, bool $deleteFolder = false, bool $trashAttachments = true): void {
		$c = $this->collections->findForUser($id, $userId);
		$folder = (string)$c->getFilesFolder();
		// Snapshot the whole collection (settings + fields + record data) so the
		// deletion can be reversed. Attachment files are trashed below; on undo the
		// data references are restored (files may need restoring from the trash bin).
		$dump = [
			'settings' => $c->jsonSerialize() + ['secret_hash' => $c->getSecretHash()],
			'fields' => array_map(fn (FieldEntity $f) => $f->jsonSerialize(), $this->fields->findForCollection($id)),
			'records' => array_map(fn (RecordEntity $r) => ['data' => json_decode($r->getData() ?: '{}', true) ?: [], 'sort' => (int)$r->getSort(), 'createdAt' => (string)$r->getCreatedAt()], $this->records->findForCollection($id)),
		];
		$this->rec($userId, 'collection.delete', null, $this->l->t('Delete the collection “%s”', [$c->getName()]), ['kind' => 'recreate_collection', 'dump' => $dump]);
		$attach = $trashAttachments ? $this->attachmentFields($id) : [];
		if (count($attach) > 0) {
			foreach ($this->records->findForCollection($id) as $r) {
				$data = json_decode($r->getData() ?: '{}', true) ?: [];
				$this->trashDataAttachments($userId, $attach, $data, $folder);
			}
		}
		$this->fields->deleteForCollection($id);
		foreach ($this->records->findForCollection($id) as $r) {
			$this->versions->drop((int)$r->getId());
		}
		$this->records->deleteForCollection($id);
		$this->shares->deleteForCollection($id);
		$this->collections->delete($c);
		// Optionally move this collection's save folder to the trash. Off by
		// default; the caller opts in. Best-effort — never blocks the delete.
		// Safety net: never remove a folder that another collection also uses
		// (that would trash the other collection's attachments).
		// And only a folder inside the RegiBase save folder: one set to "Documents" went to
		// the trash whole (review P18).
		if ($deleteFolder && $folder !== '' && $this->images->isInsideBase($userId, $folder)
			&& !$this->folderSharedByOthers($userId, $id, $folder)) {
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
		$refused = 0;
		foreach ($batch as $entry) {
			try {
				$cid = $this->applyInverse($userId, $this->history->decode($entry));
				if ($cid !== null) {
					$collectionId = $cid;
				}
			} catch (ForbiddenException|LockedException $e) {
				$refused++;   // no longer allowed there (share taken away, lowered, or locked)
			} catch (\Throwable $e) {
				// keep going; still mark undone so we never loop on a bad entry
			}
			$this->history->markUndone($entry);
			$done++;
		}
		return ['undone' => $done - $refused, 'refused' => $refused, 'summary' => $summary, 'collection_id' => $collectionId];
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

	/**
	 * Undo is a write like any other: it needs the permission the user has NOW, on a
	 * collection that is not edit-locked. The history is kept per user, so somebody a
	 * collection was shared with could still undo into it after the share was taken
	 * away, or over an edit lock (review P2).
	 */
	private function undoMayWrite(string $userId, int $collectionId): void {
		[$c] = $this->require($userId, $collectionId, self::PERM_EDIT);
		$this->assertEditable($c);
	}
	/** Collection-level undo (fields, settings, the collection itself, transfers): the owner only. */
	private function undoOwnerOnly(string $userId, int $collectionId): void {
		$this->assertEditable($this->collections->findForUser($collectionId, $userId));
	}
	private function recordCollectionId(int $recordId): ?int {
		try {
			return (int)$this->records->find($recordId)->getCollectionId();
		} catch (DoesNotExistException $e) {
			return null;
		}
	}

	/** Apply a single inverse payload. Returns the affected collection id if known. */
	private function applyInverse(string $userId, array $p): ?int {
		switch ($p['kind'] ?? '') {
			case 'del_record':
				try {
					$r = $this->records->find((int)$p['id']);
					$this->undoMayWrite($userId, (int)$r->getCollectionId());
					$this->versions->drop((int)$r->getId());
					$this->records->delete($r);
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
				$this->undoMayWrite($userId, $cid);
				$data = is_array($p['data'] ?? null) ? $p['data'] : [];
				if ((string)$this->collections->findById($cid)->getUserId() !== $userId) {
					// somebody it is shared with: the attachments stay the owner's as they are now
					$cur = json_decode($r->getData() ?: '{}', true) ?: [];
					foreach ($this->attachmentFields($cid) as $f) {
						if (array_key_exists($f['key'], $cur)) {
							$data[$f['key']] = $cur[$f['key']];
						} else {
							unset($data[$f['key']]);
						}
					}
				}
				$fieldsJson = array_map(fn (FieldEntity $f) => $f->jsonSerialize(), $this->fields->findForCollection($cid));
				$r->setData(json_encode($data ?: new \stdClass(), JSON_UNESCAPED_UNICODE));
				$r->setReading($this->computeReading($this->titleFor($fieldsJson, $data)));
				$r->setUpdatedAt($this->now());
				$this->records->update($r);
				return $cid;
			case 'reinsert':
				$rec = is_array($p['record'] ?? null) ? $p['record'] : [];
				$this->undoMayWrite($userId, (int)($rec['collectionId'] ?? 0));
				return $this->reinsertRecord($rec);
			case 'reinsert_many':
				$cid = null;
				foreach (($p['records'] ?? []) as $rec) {
					$rec = is_array($rec) ? $rec : [];
					$this->undoMayWrite($userId, (int)($rec['collectionId'] ?? 0));
					$cid = $this->reinsertRecord($rec) ?? $cid;
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
						$this->undoMayWrite($userId, (int)$r->getCollectionId());
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
						$r = $this->records->find((int)$id);
						$this->undoMayWrite($userId, (int)$r->getCollectionId());
						$this->versions->drop((int)$r->getId());
					$this->records->delete($r);
					} catch (DoesNotExistException $e) {
					}
				}
				return null;
			case 'restore_fields':
				$cid = (int)($p['collectionId'] ?? 0);
				if ($cid > 0) {
					$this->undoOwnerOnly($userId, $cid);
					$before = array_map(fn (FieldEntity $f) => $f->jsonSerialize(), $this->fields->findForCollection($cid));
					$this->fields->deleteForCollection($cid);
					$this->restoreFields($cid, is_array($p['fields'] ?? null) ? $p['fields'] : []);
					$this->dropForeignInNewAttachFields($userId, $cid, $before);
				}
				return $cid ?: null;
			case 'del_collection':
				$id = (int)($p['id'] ?? 0);
				try {
					$c = $this->collections->findForUser($id, $userId);   // the owner only
					$this->fields->deleteForCollection($id);
					foreach ($this->records->findForCollection($id) as $r) {
						$this->versions->drop((int)$r->getId());
					}
					$this->records->deleteForCollection($id);
					$this->shares->deleteForCollection($id);
					$this->collections->delete($c);
				} catch (DoesNotExistException $e) {
				}
				return null;
			case 'restore_collection':
				$this->undoOwnerOnly($userId, (int)($p['id'] ?? 0));
				return $this->restoreCollectionSettings((int)($p['id'] ?? 0), is_array($p['settings'] ?? null) ? $p['settings'] : []);
			case 'recreate_collection':
				return $this->recreateCollection($userId, is_array($p['dump'] ?? null) ? $p['dump'] : []);
			case 'undo_transfer':
				foreach (($p['createdIds'] ?? []) as $id) {
					try {
						$r = $this->records->find((int)$id);
						$this->undoOwnerOnly($userId, (int)$r->getCollectionId());
						$this->versions->drop((int)$r->getId());
					$this->records->delete($r);
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
			$e->setConcatSep(self::oneOf($f['concat_sep'] ?? null, self::CONCAT_SEPS, 'space'));
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
		// the collection's own key: without it the secret values below cannot be read again
		$c->setKeyWrap(($s['key_wrap'] ?? '') !== '' ? (string)$s['key_wrap'] : null);
		$c->setFilesFolder((string)($s['files_folder'] ?? ''));
		if (!empty($s['secret']) && ($s['secret_hash'] ?? '') !== '') {
			$c->setSecret(true);
			$c->setSecretHash((string)$s['secret_hash']);
		}
		$c->setMapProvider((string)($s['map_provider'] ?? ''));
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
		$this->dropForeignInNewAttachFields($userId, $id, $oldFields);
		return $this->getCollection($userId, $id);
	}

	/**
	 * After the fields changed: in a field that has just become an attachment field (a new one,
	 * or one of another type before), a value that is not a file the owner can open is cleared.
	 * Values stored under that key before — typed by an editor, or left from an older field —
	 * would otherwise be served to every recipient as an attachment (review P8).
	 */
	private function dropForeignInNewAttachFields(string $userId, int $cid, array $oldFields): void {
		$was = [];
		foreach ($oldFields as $f) {
			if (in_array($f['type'] ?? '', self::ATTACH_TYPES, true)) {
				$was[(string)$f['key']] = true;
			}
		}
		$now = array_map(fn (FieldEntity $f) => $f->jsonSerialize(), $this->fields->findForCollection($cid));
		$fresh = [];
		foreach ($now as $f) {
			if (in_array($f['type'], self::ATTACH_TYPES, true) && !isset($was[(string)$f['key']])) {
				$fresh[(string)$f['key']] = true;
			}
		}
		if ($fresh === []) {
			return;
		}
		foreach ($this->records->findForCollection($cid) as $r) {
			$data = json_decode($r->getData() ?: '{}', true) ?: [];
			$kept = $this->dropForeignAttachments($userId, $now, $data, $fresh);
			if ($kept !== $data) {
				$r->setData(json_encode($kept ?: new \stdClass(), JSON_UNESCAPED_UNICODE));
				$this->records->update($r);
			}
		}
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
			$e->setConcatSep(self::oneOf($f['concat_sep'] ?? null, self::CONCAT_SEPS, 'space'));
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

	/** Longest regular expression a search takes, and its backtracking bound (review P13). */
	private const REGEX_MAX_LEN = 200;
	private const REGEX_BACKTRACK_LIMIT = 100000;

	/**
	 * What a search looks through: the title and each value, one per line. Encrypted values
	 * are left out; the server cannot read them, and their text matches at random.
	 */
	private function searchText(array $r): string {
		$subject = (string)$r['title'];
		foreach ((array)$r['data'] as $v) {
			if (is_string($v) && str_starts_with($v, 'rbenc1:')) {
				continue;
			}
			$subject .= "\n" . (is_scalar($v) ? (string)$v : json_encode($v, JSON_UNESCAPED_UNICODE));
		}
		return $subject;
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
				// 'm': the title and each value are lines of their own, and ^ / $ stand at the
				// start and end of every line -- "^090" finds a phone field starting with 090,
				// as the search help says (review J10).
				$re = '~' . str_replace('~', '\\~', $q) . '~um';
				// A broken pattern is said so (400), where every record used to come back as a
				// match. The pattern is kept short and the backtracking bounded, so a pattern
				// like (a+)+$ cannot hold the server for every record (review P13).
				if (mb_strlen($q) > self::REGEX_MAX_LEN || @preg_match($re, '') === false) {
					throw new BadRegexException('Invalid regular expression');
				}
				$limit = ini_get('pcre.backtrack_limit');
				ini_set('pcre.backtrack_limit', (string)self::REGEX_BACKTRACK_LIMIT);
				try {
					$kept = [];
					foreach ($rows as $r) {
						$hit = @preg_match($re, $this->searchText($r));
						if ($hit === false) {
							throw new BadRegexException('Invalid regular expression');
						}
						if ($hit === 1) {
							$kept[] = $r;
						}
					}
					$rows = $kept;
				} finally {
					ini_set('pcre.backtrack_limit', (string)$limit);
				}
			} else {
				// The values themselves are searched, as the regular expression search does. The
				// JSON text used to be: a field key ("memo", "url") matched every record, and
				// "https://" none, JSON having written it as https:\/\/ (review P12).
				$needle = mb_strtolower(trim($q));
				$rows = array_values(array_filter($rows, fn ($r) => str_contains(mb_strtolower($this->searchText($r)), $needle)));
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

	/** Types a field's input rule applies to, and the rule's character sets, as in js/regibase.js. */
	private const RULE_TYPES = ['text', 'textarea', 'password', 'tel', 'email', 'url', 'number'];
	private const CHARSET_RE = [
		'digits' => '/^[0-9]*$/', 'alnum' => '/^[0-9A-Za-z]*$/', 'alpha' => '/^[A-Za-z]*$/',
		'hex' => '/^[0-9A-Fa-f]*$/', 'ascii' => '/^[\x20-\x7E]*$/', 'phone' => '/^[0-9+\-() #*.,;]*$/',
	];
	private const CHARSET_LABEL = [
		'digits' => 'Digits', 'alnum' => 'Alphanumeric', 'alpha' => 'Letters', 'hex' => 'Hexadecimal',
		'ascii' => 'ASCII characters', 'phone' => 'Phone number (digits, +-() )',
	];

	/**
	 * A field's input rule (characters, length, format) is checked here too; it was only a
	 * promise of the page, and the API took anything (review P14). As on the page, only
	 * the values this write changes are checked, so a record whose old value breaks a rule
	 * made stricter later, or came in by an import, can still be saved (review J15).
	 * Encrypted values cannot be read here and are left alone. The messages are the page's.
	 */
	private function assertFieldRules(array $fieldsJson, array $data, array $oldData): void {
		foreach ($fieldsJson as $f) {
			$o = $f['options'] ?? null;
			if (!empty($f['secret']) || !in_array($f['type'] ?? '', self::RULE_TYPES, true)
				|| !is_array($o) || array_is_list($o)) {
				continue;
			}
			$v = $data[$f['key']] ?? '';
			if (!is_scalar($v)) {
				continue;
			}
			$s = (string)$v;
			if ($s === '' || str_starts_with($s, 'rbenc1:')
				|| (array_key_exists($f['key'], $oldData) && is_scalar($oldData[$f['key']]) && (string)$oldData[$f['key']] === $s)) {
				continue;
			}
			$label = (string)$f['label'];
			// counted in UTF-16 units, as the page's s.length does
			$len = intdiv(strlen((string)mb_convert_encoding($s, 'UTF-16LE', 'UTF-8')), 2);
			$min = (int)($o['min'] ?? 0);
			$max = (int)($o['max'] ?? 0);
			$err = null;
			if ($min > 0 && $len < $min) {
				$err = strtr($this->l->t('{label} must be at least {min} characters'), ['{label}' => $label, '{min}' => (string)$min]);
			} elseif ($max > 0 && $len > $max) {
				$err = strtr($this->l->t('{label} must be at most {max} characters'), ['{label}' => $label, '{max}' => (string)$max]);
			} elseif (($o['charset'] ?? '') === 'custom' && is_string($o['pattern'] ?? null) && $o['pattern'] !== '') {
				// A pattern PCRE cannot read, or one that runs too long, does not stop the save;
				// the page checked it with its own engine already.
				$limit = ini_get('pcre.backtrack_limit');
				ini_set('pcre.backtrack_limit', (string)self::REGEX_BACKTRACK_LIMIT);
				$hit = @preg_match("\x01^(?:" . str_replace("\x01", '', $o['pattern']) . ")$\x01u", $s);
				ini_set('pcre.backtrack_limit', (string)$limit);
				if ($hit === 0) {
					$err = strtr($this->l->t('{label} has an invalid format'), ['{label}' => $label]);
				}
			} elseif (isset(self::CHARSET_RE[$o['charset'] ?? '']) && !preg_match(self::CHARSET_RE[$o['charset']], $s)) {
				$err = strtr($this->l->t('{label} may contain {charset} only'), ['{label}' => $label, '{charset}' => $this->l->t(self::CHARSET_LABEL[$o['charset']])]);
			}
			if ($err !== null) {
				throw new FieldRuleException($err);
			}
		}
	}

	public function createRecord(string $userId, int $collectionId, array $data): array {
		$this->requireEditable($userId, $collectionId, self::PERM_EDIT);
		$fieldsJson = array_map(fn (FieldEntity $f) => $f->jsonSerialize(), $this->fields->findForCollection($collectionId));
		$this->assertFieldRules($fieldsJson, $data, []);
		$this->assertAttachmentsKept($userId, $this->collections->findById($collectionId), $fieldsJson, $data, []);
		$this->checkAttachments($userId, $fieldsJson, $data, []);
		$data = $this->keepForeignKeys($userId, $this->collections->findById($collectionId), $fieldsJson, $data, []);
		$e = new RecordEntity();
		$e->setCollectionId($collectionId);
		$e->setData(json_encode($data ?: new \stdClass(), JSON_UNESCAPED_UNICODE));
		$e->setReading($this->computeReading($this->titleFor($fieldsJson, $data)));
		$e->setSort($this->records->maxSort($collectionId) + 1);
		$e->setCreatedAt($this->now());
		$e->setUpdatedAt($this->recordNow());
		$e = $this->records->insert($e);
		$this->rec($userId, 'record.create', $collectionId, $this->l->t('Added: %s', [$this->titleFor($fieldsJson, $data)]), ['kind' => 'del_record', 'id' => (int)$e->getId()]);
		return $this->getRecord($userId, (int)$e->getId());
	}

	public function updateRecord(string $userId, int $id, array $data, ?string $grp = null, bool $noHistory = false, bool $manualVersion = false, ?string $base = null, bool $checkRules = true): array {
		[$r, $c] = $this->recordWithPerm($userId, $id, self::PERM_EDIT);
		$this->assertEditable($c);
		// $base: when the writer opened the record. Somebody else's save since then is not
		// silently overwritten (review J18).
		if ($base !== null && $base !== '' && $base !== (string)$r->getUpdatedAt()) {
			throw new ConflictException('conflict');
		}
		$fieldsJson = array_map(fn (FieldEntity $f) => $f->jsonSerialize(), $this->fields->findForCollection((int)$c->getId()));
		$oldData = json_decode($r->getData() ?: '{}', true) ?: [];
		if ($checkRules) {
			$this->assertFieldRules($fieldsJson, $data, $oldData);
		}
		$this->assertAttachmentsKept($userId, $c, $fieldsJson, $data, $oldData);
		$this->checkAttachments($userId, $fieldsJson, $data, $oldData);
		$data = $this->keepForeignKeys($userId, $c, $fieldsJson, $data, $oldData);
		$oldReading = (string)$r->getReading();
		$r->setData(json_encode($data ?: new \stdClass(), JSON_UNESCAPED_UNICODE));
		$r->setReading($this->computeReading($this->titleFor($fieldsJson, $data)));
		$r->setUpdatedAt($this->recordNow());
		// Written only if nobody saved since $base, in the same statement: reading updated_at
		// and then writing let two saves at the same moment both pass (review J18).
		if ($base !== null && $base !== '') {
			if ($this->records->updateIfUnchanged($r, $base) === 0) {
				throw new ConflictException('conflict');
			}
		} else {
			$this->records->update($r);
		}
		// Silent updates (automatic re-encryption of secret fields) are not user
		// edits and must not enter the snapshot history — undoing one would revert
		// the encryption and expose the plaintext.
		if (!$noHistory) {
			$this->rec($userId, 'record.update', (int)$c->getId(), $this->l->t('Edited: %s', [$this->titleFor($fieldsJson, $data)]), ['kind' => 'set_data', 'id' => $id, 'data' => $oldData], $grp);
			// A numbered version of the record as it stood just before this write,
			// kept beside it the way EditBase keeps versions beside a document —
			// independent of the account-wide undo log above, and surviving past
			// its retention limit.
			// How many versions are kept, and when, is the collection owner's setting: an
			// editor it was shared with, set to keep one, wiped the owner's versions with a
			// single save (review P3).
			$owner = (string)$c->getUserId();
			$keep = $this->versions->keep($owner);
			if ($keep > 0 && $oldData !== [] && ($manualVersion || $this->versions->when($owner) === 'auto')) {
				try {
					$this->versions->take($id, ['data' => $oldData, 'reading' => $oldReading], $keep);
				} catch (\Throwable $e) {
					// A version that cannot be taken must not cost the writer their save.
				}
			}
		}
		// trash attachments that were replaced or cleared by this edit
		foreach ($fieldsJson as $f) {
			if (in_array($f['type'], self::ATTACH_TYPES, true)) {
				$old = $oldData[$f['key']] ?? '';
				$new = $data[$f['key']] ?? '';
				if ($old !== '' && (string)$old !== (string)$new) {
					$this->images->trashIfOwned($userId, (string)$old, (string)$c->getFilesFolder());
				}
			}
		}
		return $this->getRecord($userId, $id);
	}

	// ---- per-record version history ----

	public function versionKeep(string $userId): int {
		return $this->versions->keep($userId);
	}

	public function setVersionKeep(string $userId, int $n): int {
		return $this->versions->setKeep($userId, $n);
	}

	public function versionWhen(string $userId): string {
		return $this->versions->when($userId);
	}

	public function setVersionWhen(string $userId, string $when): string {
		return $this->versions->setWhen($userId, $when);
	}

	/** The versions kept beside a record, newest first. */
	public function recordVersions(string $userId, int $id): array {
		[, $c] = $this->recordWithPerm($userId, $id, self::PERM_VIEW);
		unset($c);
		return $this->versions->list($id);
	}

	/** What one version of a record held: the same shape as getRecord()'s `data`. */
	public function readRecordVersion(string $userId, int $id, int $number): array {
		[, $c] = $this->recordWithPerm($userId, $id, self::PERM_VIEW);
		unset($c);
		$snap = $this->versions->read($id, $number);
		return is_array($snap['data'] ?? null) ? $snap['data'] : [];
	}

	/**
	 * Put a version back. What is there now becomes #1 first (this is routed
	 * through updateRecord(), which both records the usual undo entry and takes
	 * that version), so restoring can itself be undone either way.
	 */
	public function restoreRecordVersion(string $userId, int $id, int $number): array {
		[, $c] = $this->recordWithPerm($userId, $id, self::PERM_EDIT);
		$this->assertEditable($c);
		$snap = $this->versions->read($id, $number);
		$restoredData = is_array($snap['data'] ?? null) ? $snap['data'] : [];
		if ((string)$c->getUserId() !== $userId) {
			// somebody it is shared with restores the text; the attachments stay the owner's as they are
			$cur = json_decode($this->records->find($id)->getData() ?: '{}', true) ?: [];
			foreach ($this->attachmentFields((int)$c->getId()) as $f) {
				if (array_key_exists($f['key'], $cur)) {
					$restoredData[$f['key']] = $cur[$f['key']];
				} else {
					unset($restoredData[$f['key']]);
				}
			}
		}
		// a version brings back what was there, even where a rule changed since (review P14)
		return $this->updateRecord($userId, $id, $restoredData, null, false, true, null, false);
	}

	/**
	 * Update many records of one collection in a single call (used by find & replace).
	 * The collection is permission-checked once and its fields loaded once, so this is
	 * dramatically faster than one HTTP PUT per record. All edits share $grp for undo.
	 * @param array $updates list of ['id' => int, 'data' => array]
	 * @return int number of records actually updated
	 */
	/**
	 * @return array{updated:int, conflicts:int} conflicts: records somebody else saved after
	 *         the writer loaded them (each update may carry the updated_at it was made from as
	 *         _base); those are left as they are (review J18)
	 */
	public function bulkUpdateRecords(string $userId, int $collectionId, array $updates, ?string $grp = null): array {
		[$c] = $this->requireEditable($userId, $collectionId, self::PERM_EDIT); // owner/edit + not locked
		// versions follow the owner's setting, as in updateRecord (review P22)
		$owner = (string)$c->getUserId();
		$keep = $this->versions->keep($owner);
		$autoVersion = $keep > 0 && $this->versions->when($owner) === 'auto';
		$fieldsJson = array_map(fn (FieldEntity $f) => $f->jsonSerialize(), $this->fields->findForCollection($collectionId));
		$attach = array_values(array_filter($fieldsJson, fn ($f) => in_array($f['type'], self::ATTACH_TYPES, true)));
		$now = $this->recordNow();
		$n = 0;
		$conflicts = 0;
		// every new attachment is checked before anything is written
		foreach ($updates as $u) {
			try {
				$r = $this->records->find((int)($u['id'] ?? 0));
			} catch (DoesNotExistException $e) {
				continue;
			}
			if ((int)$r->getCollectionId() === $collectionId && is_array($u['data'] ?? null)) {
				$old = json_decode($r->getData() ?: '{}', true) ?: [];
				$this->assertFieldRules($fieldsJson, $u['data'], $old);
				$this->assertAttachmentsKept($userId, $c, $fieldsJson, $u['data'], $old);
				$this->checkAttachments($userId, $fieldsJson, $u['data'], $old);
			}
		}
		foreach ($updates as $u) {
			$id = (int)($u['id'] ?? 0);
			if ($id <= 0) {
				continue;
			}
			// An update without its data is skipped: it was checked by nothing above and
			// wrote an empty record, attachments and all (review P8).
			if (!isset($u['data']) || !is_array($u['data'])) {
				continue;
			}
			try {
				$r = $this->records->find($id);
			} catch (DoesNotExistException $e) {
				continue;
			}
			if ((int)$r->getCollectionId() !== $collectionId) {
				continue; // never touch a record outside the authorised collection
			}
			$oldData = json_decode($r->getData() ?: '{}', true) ?: [];
			$data = $this->keepForeignKeys($userId, $c, $fieldsJson, $u['data'], $oldData);
			$oldReading = (string)$r->getReading();
			$r->setData(json_encode($data ?: new \stdClass(), JSON_UNESCAPED_UNICODE));
			$r->setReading($this->computeReading($this->titleFor($fieldsJson, $data)));
			$r->setUpdatedAt($now);
			$base = isset($u['_base']) && is_string($u['_base']) ? $u['_base'] : '';
			if ($base !== '') {
				if ($this->records->updateIfUnchanged($r, $base) === 0) {
					$conflicts++;   // saved by somebody else meanwhile: left as it is
					continue;
				}
			} else {
				$this->records->update($r);
			}
			$this->rec($userId, 'record.update', $collectionId, $this->l->t('Edited: %s', [$this->titleFor($fieldsJson, $data)]), ['kind' => 'set_data', 'id' => $id, 'data' => $oldData], $grp);
			if ($autoVersion && $oldData !== []) {
				try {
					$this->versions->take($id, ['data' => $oldData, 'reading' => $oldReading], $keep);
				} catch (\Throwable $e) {
					// a version that cannot be taken must not cost the writer their save
				}
			}
			foreach ($attach as $f) {
				$old = $oldData[$f['key']] ?? '';
				$new = $data[$f['key']] ?? '';
				if ($old !== '' && (string)$old !== (string)$new) {
					$this->images->trashIfOwned($userId, (string)$old, (string)$c->getFilesFolder());
				}
			}
			$n++;
		}
		return ['updated' => $n, 'conflicts' => $conflicts];
	}

	/** Permission-checked delete that returns the data needed to re-create it (for undo). */
	private function deleteRecordCapture(string $userId, int $id): array {
		[$r, $c] = $this->recordWithPerm($userId, $id, self::PERM_DELETE);
		$this->assertEditable($c);
		$data = json_decode($r->getData() ?: '{}', true) ?: [];
		if ((string)$c->getUserId() === $userId) {
			$this->trashDataAttachments($userId, $this->attachmentFields((int)$c->getId()), $data, (string)$c->getFilesFolder());
		}
		$snap = ['collectionId' => (int)$c->getId(), 'data' => $data, 'sort' => (int)$r->getSort(), 'createdAt' => (string)$r->getCreatedAt()];
		// Undoing this delete re-creates the record under a new id, so the version
		// history under the old id would otherwise be orphaned for good.
		$this->versions->drop($id);
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
			// A collection shared with its secrets has a key of its own. An encrypted
			// value copied across to a collection under another key could never be
			// opened there, so it is refused rather than copied (review K3).
			if (($srcEntity->getKeyWrap() ?? '') !== ($tgtEntity->getKeyWrap() ?? '')) {
				foreach ($sourceData as $v) {
					if (is_string($v) && str_starts_with($v, 'rbenc1:')) {
						throw new \RuntimeException('Encrypted secret fields cannot be moved or copied between collections with different keys. Open the secret fields as plain text first, or copy them by hand.');
					}
				}
			}
			// onto an attachment field only a file the owner can open (review P8)
			$mapped[] = $this->dropForeignAttachments($userId, $target['fields'], $this->mapData($sourceData, $cleanMapping, $appendTo, $source['fields']));
			$moveIds[] = (int)$r->getId();
		}

		$createdIds = $this->bulkInsertRecordsIds($targetId, $mapped);
		$movedBack = [];
		if ($mode === 'move') {
			foreach ($moveIds as $mid) {
				try {
					$r = $this->records->find($mid);
					$movedBack[] = ['collectionId' => $sourceId, 'data' => json_decode($r->getData() ?: '{}', true) ?: [], 'sort' => (int)$r->getSort(), 'createdAt' => (string)$r->getCreatedAt()];
					$this->versions->drop((int)$r->getId());
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
				$records[] = ['data' => $data, 'created_at' => (string)$r->getCreatedAt(), 'sort' => (int)$r->getSort()];
			}
			$cj = $c->jsonSerialize();
			// who it is shared with, as it is stored (hashes and wrapped keys, never a password)
			$shares = array_map(fn (ShareEntity $sh) => [
				'recipient' => (string)$sh->getRecipientUid(), 'type' => (string)$sh->getRecipientType(), 'perm' => (string)$sh->getPerm(),
				'pw_hash' => $sh->getPwHash(), 'auth_salt' => $sh->getAuthSalt(), 'enc_key' => $sh->getEncKey(), 'enc_salt' => $sh->getEncSalt(),
				'expires_at' => $sh->getExpiresAt(), 'created_at' => (string)$sh->getCreatedAt(),
			], $this->shares->findForCollection($cid));
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
				// the collection's own key (wrapped with the master key), or its secrets cannot be read after a restore
				'key_wrap' => $cj['key_wrap'] ?? null,
				// settings a restore used to lose: a hidden collection came back in plain view,
				// unlocked, in another order, with a different save folder (review P10, K6)
				'secret' => (bool)$c->getSecret(),
				'secret_hash' => $c->getSecretHash(),
				'locked' => (bool)$c->getLocked(),
				'files_folder' => (string)$c->getFilesFolder(),
				'map_provider' => (string)$c->getMapProvider(),
				'sort' => (int)$c->getSort(),
				'shares' => $shares,
				'fields' => $fieldsJson,
				'records' => $records,
			];
		}
		$templates = array_map(fn ($t) => [
			'tpl_key' => (string)$t->getTplKey(), 'builtin_key' => $t->getBuiltinKey(), 'name' => (string)$t->getName(), 'icon' => (string)$t->getIcon(),
			'color' => (string)$t->getColor(), 'description' => (string)$t->getDescription(), 'fields' => (string)$t->getFields(), 'sort' => (int)$t->getSort(),
		], \OCP\Server::get(\OCA\RegiBase\Db\TemplateMapper::class)->findAllForUser($userId));
		return [
			'struct' => ['app' => 'RegiBase', 'backup_version' => 2, 'exported_at' => $this->now(), 'collections' => $collections, 'templates' => $templates],
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
		// The old attachments are only moved to the trash by the caller once everything
		// has been written (an overwrite that failed half way used to leave the records
		// pointing at files already in the trash, review K16).
		$oldAttachments = [];
		if ($mode === 'overwrite') {
			foreach ($this->collections->findAllForUser($userId) as $c) {
				$cid0 = (int)$c->getId();
				$keys0 = $this->attachmentKeys(array_map(fn (FieldEntity $f) => $f->jsonSerialize(), $this->fields->findForCollection($cid0)));
				foreach ($this->records->findForCollection($cid0) as $r) {
					$d = json_decode($r->getData() ?: '{}', true) ?: [];
					foreach ($keys0 as $k) {
						if (preg_match('/^\d+$/', (string)($d[$k] ?? ''))) {
							$oldAttachments[(string)$d[$k]] = (string)$c->getFilesFolder();
						}
					}
				}
				$this->deleteCollection($userId, $cid0, false, false);
			}
			$this->restoreTemplates($userId, is_array($struct['templates'] ?? null) ? $struct['templates'] : [], true);
		} elseif (is_array($struct['templates'] ?? null)) {
			$this->restoreTemplates($userId, $struct['templates'], false);
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
					$existingByName[$name] = ['id' => $cid, 'sigs' => $sigs, 'wrap' => (string)($c->getKeyWrap() ?? ''), 'locked' => (bool)$c->getLocked()];
				}
			}
		}

		$colCount = 0;
		$recCount = 0;
		foreach (($struct['collections'] ?? []) as $col) {
			$fields = is_array($col['fields'] ?? null) ? $col['fields'] : [];
			$attachKeys = $this->attachmentKeys($fields);
			$name = (string)($col['name'] ?? 'RegiBase');

			// Records under a collection key of their own only go into a collection under
			// the same key; otherwise they come back as a collection of their own.
			// A collection locked against editing is not merged into: it comes back as a new one.
			if ($mode === 'merge' && isset($existingByName[$name]) && $existingByName[$name]['wrap'] === (string)($col['key_wrap'] ?? '')
				&& !$existingByName[$name]['locked']) {
				$cid = $existingByName[$name]['id'];
				// The fields are matched by key, else by name and type; the rest are added. A
				// collection made separately under the same name has other keys, and the merged
				// values used to sit under keys no column showed (review K7).
				$keyMap = $this->matchFields($userId, $cid, $fields);
				$attachNow = $this->attachmentKeys(array_map(fn (FieldEntity $f) => $f->jsonSerialize(), $this->fields->findForCollection($cid)));
				$dataArray = [];
				foreach (($col['records'] ?? []) as $rec) {
					$data0 = $this->remapAttachments($userId, is_array($rec['data'] ?? null) ? $rec['data'] : [], $attachKeys, $fileIdMap);
					$data = [];
					foreach ($data0 as $k => $v) {
						$data[$keyMap[(string)$k] ?? (string)$k] = $v;
					}
					$sig = $this->recordSignature($data, $attachNow);
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
			$ce = $this->collections->findForUser($cid, $userId);
			if (!empty($col['key_wrap'])) {
				$ce->setKeyWrap((string)$col['key_wrap']);
			}
			if (!empty($col['secret']) && is_string($col['secret_hash'] ?? null) && $col['secret_hash'] !== '') {
				$ce->setSecret(true);
				$ce->setSecretHash($col['secret_hash']);
			}
			$ce->setLocked(!empty($col['locked']));
			// the same checks as a folder or map set in the collection's settings
			$folder = is_string($col['files_folder'] ?? null) ? mb_substr($this->images->normalizePath($col['files_folder']), 0, 512) : '';
			if ($folder !== '') {
				$ce->setFilesFolder($folder);
			}
			// an empty choice is left unset, as the collection had it (not stored as '')
			if (is_string($col['map_provider'] ?? null) && $col['map_provider'] !== '' && in_array($col['map_provider'], self::MAP_PROVIDERS, true)) {
				$ce->setMapProvider($col['map_provider']);
			}
			if ($mode === 'overwrite' && isset($col['sort'])) {
				$ce->setSort((int)$col['sort']);
			}
			$this->collections->update($ce);
			$recs = [];
			foreach (($col['records'] ?? []) as $rec) {
				$recs[] = ['data' => $this->remapAttachments($userId, is_array($rec['data'] ?? null) ? $rec['data'] : [], $attachKeys, $fileIdMap)]
					+ array_intersect_key($rec, ['created_at' => 1, 'sort' => 1]);
			}
			$recCount += $this->insertRestored($cid, $recs);
			// the shares come back only with a full overwrite, and only to people and groups that still exist
			if ($mode === 'overwrite') {
				foreach ((is_array($col['shares'] ?? null) ? $col['shares'] : []) as $sh) {
					$this->restoreShare($userId, $cid, is_array($sh) ? $sh : []);
				}
			}
			$colCount++;
		}
		// old attachments the restored records still point at stay where they are
		foreach ($this->collections->findAllForUser($userId) as $c) {
			$keys1 = $this->attachmentKeys(array_map(fn (FieldEntity $f) => $f->jsonSerialize(), $this->fields->findForCollection((int)$c->getId())));
			foreach ($this->records->findForCollection((int)$c->getId()) as $r) {
				$d = json_decode($r->getData() ?: '{}', true) ?: [];
				foreach ($keys1 as $k) {
					unset($oldAttachments[(string)($d[$k] ?? '')]);
				}
			}
		}
		return ['collections' => $colCount, 'records' => $recCount, 'mode' => $mode, '_trash' => $oldAttachments];
	}

	/**
	 * For a merge: which existing field each field of the backup goes into (same key and type,
	 * else same name and type), adding the ones that have no match. @return array<string,string>
	 */
	private function matchFields(string $userId, int $cid, array $fields): array {
		$existing = array_map(fn (FieldEntity $f) => $f->jsonSerialize(), $this->fields->findForCollection($cid));
		$byKey = [];
		$byLabel = [];
		// The secret flag is part of the match: a backup's secret field merged into a plain one
		// showed its ciphertext, and a plain one merged into a secret field left plain text
		// on the server (review, second look).
		$sig = static fn (array $f): string => (string)($f['type'] ?? 'text') . "\0" . (!empty($f['secret']) ? 's' : '');
		foreach ($existing as $f) {
			$byKey[(string)$f['key']] = $sig($f);
			$byLabel[mb_strtolower(trim((string)$f['label'])) . "\0" . $sig($f)][] = (string)$f['key'];
		}
		$map = [];
		$taken = [];
		$add = [];
		foreach ($fields as $f) {
			$bk = (string)($f['key'] ?? '');
			$type = $sig($f);
			if ($bk === '') {
				continue;
			}
			if (($byKey[$bk] ?? null) === $type && !isset($taken[$bk])) {
				$map[$bk] = $bk;
				$taken[$bk] = true;
				continue;
			}
			foreach ($byLabel[mb_strtolower(trim((string)($f['label'] ?? ''))) . "\0" . $type] ?? [] as $ek) {
				if (!isset($taken[$ek])) {
					$map[$bk] = $ek;
					$taken[$ek] = true;
					continue 2;
				}
			}
			$nk = $bk;
			for ($n = 2; isset($byKey[$nk]) || isset($taken[$nk]); $n++) {
				$nk = $bk . '_' . $n;
			}
			$map[$bk] = $nk;
			$taken[$nk] = true;
			$add[] = ['key' => $nk] + $f;
		}
		if ($add) {
			$this->appendFields($userId, $cid, $add);
		}
		return $map;
	}

	/** Move to the trash the old attachments a finished overwrite restore no longer uses. */
	public function trashAfterRestore(string $userId, array $oldAttachments): void {
		foreach ($oldAttachments as $id => $folder) {
			$this->images->trashIfOwned($userId, (string)$id, (string)$folder);
		}
	}

	/** Records from a backup, with their own dates and order when the backup has them. */
	private function insertRestored(int $collectionId, array $recs): int {
		$fieldsJson = array_map(fn (FieldEntity $f) => $f->jsonSerialize(), $this->fields->findForCollection($collectionId));
		$ts = $this->now();
		$sort = $this->records->maxSort($collectionId);
		$n = 0;
		foreach ($recs as $rec) {
			$data = is_array($rec['data'] ?? null) ? $rec['data'] : [];
			$e = new RecordEntity();
			$e->setCollectionId($collectionId);
			$e->setData(json_encode($data ?: new \stdClass(), JSON_UNESCAPED_UNICODE));
			$e->setReading($this->computeReading($this->titleFor($fieldsJson, $data)));
			$e->setSort(isset($rec['sort']) ? (int)$rec['sort'] : ++$sort);
			$e->setCreatedAt(is_string($rec['created_at'] ?? null) && $rec['created_at'] !== '' ? $rec['created_at'] : $ts);
			$e->setUpdatedAt($ts);
			$this->records->insert($e);
			$n++;
		}
		return $n;
	}

	private function restoreShare(string $ownerUid, int $cid, array $sh): void {
		$type = ($sh['type'] ?? 'user') === 'group' ? 'group' : 'user';
		$to = (string)($sh['recipient'] ?? '');
		if ($to === '' || $to === $ownerUid || ($type === 'user' ? $this->userManager->get($to) === null : !$this->groupManager->groupExists($to))) {
			return;
		}
		// A backup is written by its user and can say anything: its shares follow the same
		// rules as shares made on the page — the Nextcloud sharing policy, one share per
		// recipient, a real end date (review, second look).
		try {
			$this->checkSharePolicy($ownerUid, $type, $to);
			$expires = $this->cleanDate($sh['expires_at'] ?? null);
		} catch (\RuntimeException $e) {
			return;
		}
		if ($this->shares->findOne($cid, $to, $type) !== null) {
			return;
		}
		$s = new ShareEntity();
		$s->setCollectionId($cid);
		$s->setOwnerUid($ownerUid);
		$s->setRecipientUid($to);
		$s->setRecipientType($type);
		$s->setPerm(isset(self::PERM_RANK[(string)($sh['perm'] ?? '')]) ? (string)$sh['perm'] : self::PERM_VIEW);
		foreach (['PwHash' => 'pw_hash', 'AuthSalt' => 'auth_salt', 'EncKey' => 'enc_key', 'EncSalt' => 'enc_salt'] as $set => $k) {
			$s->{'set' . $set}(is_string($sh[$k] ?? null) && $sh[$k] !== '' ? $sh[$k] : null);
		}
		if (($s->getPwHash() ?? '') === '') {
			// a wrapped key needs a share password to open it, as addShare requires
			$s->setEncKey(null);
			$s->setEncSalt(null);
			$s->setAuthSalt(null);
		}
		$s->setExpiresAt($expires);
		$s->setCreatedAt(is_string($sh['created_at'] ?? null) && $sh['created_at'] !== '' ? $sh['created_at'] : $this->now());
		if (ShareEntity::isPast($s->getExpiresAt(), ShareEntity::ownerZone($ownerUid))) {
			return; // it ran out while it was in the backup
		}
		$this->shares->insert($s);
	}

	/** Templates from a backup: all of them replace the user's own on an overwrite; otherwise only new ones are added. */
	private function restoreTemplates(string $userId, array $list, bool $replace): void {
		$tm = \OCP\Server::get(\OCA\RegiBase\Db\TemplateMapper::class);
		$have = [];
		foreach ($tm->findAllForUser($userId) as $t) {
			if ($replace) {
				$tm->delete($t);
			} else {
				$have[(string)$t->getTplKey()] = true;
			}
		}
		foreach ($list as $t) {
			if (!is_array($t) || !is_string($t['tpl_key'] ?? null) || $t['tpl_key'] === '' || isset($have[$t['tpl_key']])) {
				continue;
			}
			$e = new \OCA\RegiBase\Db\TemplateEntity();
			$e->setUserId($userId);
			$e->setTplKey($t['tpl_key']);
			$e->setBuiltinKey(is_string($t['builtin_key'] ?? null) ? $t['builtin_key'] : null);
			$e->setName((string)($t['name'] ?? ''));
			$e->setIcon((string)($t['icon'] ?? '📁'));
			$e->setColor((string)($t['color'] ?? '#3b82f6'));
			$e->setDescription((string)($t['description'] ?? ''));
			$e->setFields(is_string($t['fields'] ?? null) ? $t['fields'] : json_encode($t['fields'] ?? [], JSON_UNESCAPED_UNICODE));
			$e->setSort((int)($t['sort'] ?? 0));
			$e->setCreatedAt($this->now());
			$e->setUpdatedAt($this->now());
			$tm->insert($e);
			$have[$t['tpl_key']] = true;
		}
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
		$list = $this->shares->findForCollection($collectionId);
		foreach ($list as $s) {
			$this->purgeIfExpired($s);
		}
		return array_map(fn (ShareEntity $s) => $s->jsonSerialize() + ['paused' => !$this->shareAllowedNow($s)], $list);
	}

	/**
	 * Share a collection with another user or a whole group (owner only).
	 * $recipientType: 'user' | 'group'.
	 * $auth/$authSalt: a value derived from the share password in the page, and its salt. The
	 * password itself never reaches the server (review K3): the server keeps a hash of $auth.
	 * $encKey/$encSalt: the COLLECTION's own key wrapped with the share password (optional;
	 * lets the recipient read the secret fields). Never the owner's master key.
	 * $expiresAt: YYYY-MM-DD, the last day the share works; null for no end.
	 */
	public function addShare(string $ownerUid, int $collectionId, string $recipientUid, string $perm,
		?string $auth, ?string $authSalt, ?string $encKey, ?string $encSalt, ?string $expiresAt, string $recipientType = 'user'): array {
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
		$this->checkSharePolicy($ownerUid, $recipientType, $recipientUid);
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
		$hasAuth = $auth !== null && $auth !== '';
		$s->setPwHash($hasAuth ? password_hash($auth, PASSWORD_DEFAULT) : null);
		$s->setAuthSalt($hasAuth ? (string)$authSalt : null);
		// a wrapped key needs a password to open it
		$s->setEncKey(($hasAuth && $encKey !== null && $encKey !== '') ? $encKey : null);
		$s->setEncSalt(($hasAuth && $encSalt !== null && $encSalt !== '') ? $encSalt : null);
		$s->setExpiresAt($this->cleanDate($expiresAt));
		$s->setCreatedAt($this->now());
		return $this->shares->insert($s)->jsonSerialize();
	}

	/**
	 * The administrator's sharing settings apply here as they do in Files: sharing may be off
	 * (for everybody or for the owner's groups), group sharing may be off, and sharing may be
	 * limited to people the owner shares a group with.
	 */
	public function checkSharePolicy(string $ownerUid, string $recipientType, string $recipientUid): void {
		if (!$this->shareManager->shareApiEnabled() || $this->shareManager->sharingDisabledForUser($ownerUid)) {
			throw new \RuntimeException('Sharing is not allowed for your account');
		}
		if ($recipientType === 'group' && !$this->shareManager->allowGroupSharing()) {
			throw new \RuntimeException('Sharing with groups is not allowed');
		}
		if ($this->shareManager->shareWithGroupMembersOnly()) {
			$mine = array_diff($this->userGroupIds($ownerUid), $this->shareManager->shareWithGroupMembersOnlyExcludeGroupsList());
			$ok = $recipientType === 'group'
				? in_array($recipientUid, $mine, true)
				: array_intersect($mine, $this->userGroupIds($recipientUid)) !== [];
			if (!$ok) {
				// The same answer as for a name that does not exist: a separate message told
				// which accounts exist outside one's groups, where the admin limits lookup (review, second look).
				throw new \RuntimeException($recipientType === 'group' ? 'No such group' : 'No such user');
			}
		}
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
		if (array_key_exists('auth', $patch)) {
			// a new share password (or none): the old wrapped key goes with the old password
			$a = $patch['auth'];
			$has = $a !== null && $a !== '';
			$s->setPwHash($has ? password_hash((string)$a, PASSWORD_DEFAULT) : null);
			$s->setAuthSalt($has ? (string)($patch['auth_salt'] ?? '') : null);
			$s->setEncKey(null);
			$s->setEncSalt(null);
		}
		if (array_key_exists('enc_key', $patch) && ($s->getPwHash() ?? '') !== '') {
			$s->setEncKey($patch['enc_key'] ? (string)$patch['enc_key'] : null);
			$s->setEncSalt((isset($patch['enc_salt']) && $patch['enc_salt']) ? (string)$patch['enc_salt'] : null);
		}
		if (array_key_exists('expires_at', $patch)) {
			$s->setExpiresAt($this->cleanDate($patch['expires_at']));
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
	public function unlockShare(string $recipientUid, int $collectionId, string $auth): array {
		$s = $this->bestShare($collectionId, $recipientUid);
		if ($s === null) {
			throw new DoesNotExistException('not shared with you');
		}
		if ($s->getPwHash() !== null && $s->getPwHash() !== '') {
			// $auth is derived from the share password in the page; the password never comes here.
			if (!password_verify($auth, (string)$s->getPwHash())) {
				throw new ForbiddenException('incorrect share password');
			}
		}
		$this->markShareUnlocked($s);
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

	private function remapAttachments(string $userId, array $data, array $attachKeys, array $fileIdMap): array {
		foreach ($attachKeys as $k) {
			$v = $data[$k] ?? '';
			if ($v === '' || $v === null) {
				continue;
			}
			if (isset($fileIdMap[(string)$v])) {
				$data[$k] = (string)$fileIdMap[(string)$v];
			} elseif (!preg_match('/^\d+$/', (string)$v) || !$this->images->canRead($userId, (string)$v)) {
				// An id the backup brought no file for is kept only when it is a file of the
				// user's own (the attachment still in place): from another server, or crafted,
				// it could name an unrelated file (review, second look).
				unset($data[$k]);
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
