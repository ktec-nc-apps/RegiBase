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
use OCP\IL10N;
use OCP\ISession;

class RegiBaseService {
	private const ALLOWED_VIEWS = ['card', 'list', 'detail', 'image', 'table'];
	private const ALLOWED_SORTS = ['created_asc', 'created_desc', 'title_asc', 'title_desc'];
	private const ATTACH_TYPES = ['image', 'image_crop', 'file'];
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
	) {
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
		$share = $this->shares->findOne($id, $userId);
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
			$j = $c->jsonSerialize();
			$j['record_count'] = $this->records->countForCollection((int)$c->getId());
			$out[] = $this->decorateShare($j, true, null);
		}
		// collections other users have shared with me
		foreach ($this->shares->findForRecipient($userId) as $share) {
			try {
				$c = $this->collections->findById((int)$share->getCollectionId());
			} catch (DoesNotExistException $e) {
				continue; // stale share whose collection was deleted
			}
			$j = $c->jsonSerialize();
			$j['record_count'] = $this->records->countForCollection((int)$c->getId());
			$out[] = $this->decorateShare($j, false, $share);
		}
		return $out;
	}

	public function getCollection(string $userId, int $id): array {
		[$c, , $isOwner, $share] = $this->resolve($userId, $id);
		$j = $c->jsonSerialize();
		$j['fields'] = array_map(fn (FieldEntity $f) => $f->jsonSerialize(), $this->fields->findForCollection($id));
		return $this->decorateShare($j, $isOwner, $share);
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
		$view = $input['view'] ?? 'list';
		$c->setView(in_array($view, self::ALLOWED_VIEWS, true) ? $view : 'list');
		$c->setRecordSort('created_desc');
		$c->setSort($this->collections->maxSort($userId) + 1);
		$c->setCreatedAt($this->now());
		$c->setUpdatedAt($this->now());
		$c = $this->collections->insert($c);

		$fields = $input['fields'] ?? ($tpl['fields'] ?? []);
		$this->insertFields((int)$c->getId(), $fields);
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
		// editing collection settings (name/icon/color/description/view/sort) needs
		// ownership or the highest recipient level ('delete'); 'edit'/'view' cannot.
		[$c] = $this->require($userId, $id, self::PERM_DELETE);
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
		$c->setUpdatedAt($this->now());
		$this->collections->update($c);
		return $this->getCollection($userId, $id);
	}

	public function deleteCollection(string $userId, int $id): void {
		$c = $this->collections->findForUser($id, $userId);
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
	}

	public function replaceFields(string $userId, int $id, array $fields): array {
		$this->collections->findForUser($id, $userId); // ownership check
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
		foreach ($fields as $idx => $f) {
			$e = new FieldEntity();
			$e->setCollectionId($collectionId);
			$e->setFieldKey((string)($f['key'] ?? ('f_' . $idx)));
			$e->setLabel((string)($f['label'] ?? ''));
			$e->setType((string)($f['type'] ?? 'text'));
			$e->setOptions(!empty($f['options']) ? json_encode($f['options']) : null);
			$e->setRequired(!empty($f['required']));
			$e->setSecret(!empty($f['secret']));
			$e->setIsTitle(!$hasTitle && $idx === 0 ? true : !empty($f['is_title']));
			$e->setPlaceholder($f['placeholder'] ?? null);
			$e->setSort($idx);
			$this->fields->insert($e);
		}
	}

	// ---- records ----
	private function titleFor(array $fields, array $data): string {
		foreach ($fields as $f) {
			if (($f['is_title'] ?? false) && !empty($data[$f['key']])) {
				return (string)$data[$f['key']];
			}
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

	public function listRecords(string $userId, int $collectionId, ?string $q, ?string $sort): array {
		[$c] = $this->resolve($userId, $collectionId); // any recipient level may read
		$fieldsJson = array_map(fn (FieldEntity $f) => $f->jsonSerialize(), $this->fields->findForCollection($collectionId));
		$mode = ($sort && in_array($sort, self::ALLOWED_SORTS, true)) ? $sort : $c->getRecordSort();

		$rows = [];
		foreach ($this->records->findForCollection($collectionId) as $r) {
			$j = $r->jsonSerialize();
			$j['title'] = $this->titleFor($fieldsJson, $j['data']);
			$rows[] = $j;
		}

		if ($q !== null && trim($q) !== '') {
			$needle = mb_strtolower(trim($q));
			$rows = array_values(array_filter($rows, function ($r) use ($needle) {
				return str_contains(mb_strtolower($r['title']), $needle)
					|| str_contains(mb_strtolower(json_encode($r['data'], JSON_UNESCAPED_UNICODE)), $needle);
			}));
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
		switch ($mode) {
			case 'created_asc': usort($rows, fn ($a, $b) => $a['id'] - $b['id']); break;
			case 'title_asc': usort($rows, $cmpTitle); break;
			case 'title_desc': usort($rows, fn ($a, $b) => -$cmpTitle($a, $b)); break;
			case 'created_desc':
			default: usort($rows, fn ($a, $b) => $b['id'] - $a['id']); break;
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
		$j['title'] = $this->titleFor($fieldsJson, $j['data']);
		return $j;
	}

	public function createRecord(string $userId, int $collectionId, array $data): array {
		$this->require($userId, $collectionId, self::PERM_EDIT);
		$fieldsJson = array_map(fn (FieldEntity $f) => $f->jsonSerialize(), $this->fields->findForCollection($collectionId));
		$e = new RecordEntity();
		$e->setCollectionId($collectionId);
		$e->setData(json_encode($data ?: new \stdClass(), JSON_UNESCAPED_UNICODE));
		$e->setReading($this->computeReading($this->titleFor($fieldsJson, $data)));
		$e->setCreatedAt($this->now());
		$e->setUpdatedAt($this->now());
		$e = $this->records->insert($e);
		return $this->getRecord($userId, (int)$e->getId());
	}

	public function updateRecord(string $userId, int $id, array $data): array {
		[$r, $c] = $this->recordWithPerm($userId, $id, self::PERM_EDIT);
		$fieldsJson = array_map(fn (FieldEntity $f) => $f->jsonSerialize(), $this->fields->findForCollection((int)$c->getId()));
		$oldData = json_decode($r->getData() ?: '{}', true) ?: [];
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

	public function deleteRecord(string $userId, int $id): void {
		[$r, $c] = $this->recordWithPerm($userId, $id, self::PERM_DELETE);
		$data = json_decode($r->getData() ?: '{}', true) ?: [];
		$this->trashDataAttachments($userId, $this->attachmentFields((int)$c->getId()), $data);
		$this->records->delete($r);
	}

	public function deleteRecords(string $userId, array $ids): int {
		$n = 0;
		foreach ($ids as $id) {
			try {
				$this->deleteRecord($userId, (int)$id);
				$n++;
			} catch (DoesNotExistException | ForbiddenException $e) {
				// skip records the user cannot delete
			}
		}
		return $n;
	}

	// ---- fields (append) ----
	/**
	 * Append new fields to a collection (used by transfer "add as new field").
	 * Skips keys that already exist; forces is_title=false. Returns keys added.
	 */
	public function appendFields(string $userId, int $collectionId, array $fields): array {
		$this->collections->findForUser($collectionId, $userId); // ownership
		$existingFields = $this->fields->findForCollection($collectionId);
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
		$fieldsJson = array_map(fn (FieldEntity $f) => $f->jsonSerialize(), $this->fields->findForCollection($collectionId));
		$ts = $this->now();
		$n = 0;
		foreach ($dataArray as $data) {
			$data = is_array($data) ? $data : [];
			$e = new RecordEntity();
			$e->setCollectionId($collectionId);
			$e->setData(json_encode($data ?: new \stdClass(), JSON_UNESCAPED_UNICODE));
			$e->setReading($this->computeReading($this->titleFor($fieldsJson, $data)));
			$e->setCreatedAt($ts);
			$e->setUpdatedAt($ts);
			$this->records->insert($e);
			$n++;
		}
		return $n;
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

		$this->collections->findForUser($sourceId, $userId); // transfer is owner-only (both sides)
		$source = $this->getCollection($userId, $sourceId); // fields
		$this->collections->findForUser($targetId, $userId); // ownership of target

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

		$count = $this->bulkInsertRecords($targetId, $mapped);
		if ($mode === 'move') {
			foreach ($moveIds as $mid) {
				try {
					$this->records->delete($this->records->find($mid));
				} catch (DoesNotExistException $e) {
					// skip
				}
			}
		}
		return ['count' => $count];
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
		$this->collections->findForUser($collectionId, $userId); // authz: throws if not owner
		return $this->bulkInsertRecords($collectionId, $dataArray);
	}

	// ---- shares (internal sharing between users) ----

	/** List a collection's shares (owner only). @return array[] */
	public function listShares(string $ownerUid, int $collectionId): array {
		$this->collections->findForUser($collectionId, $ownerUid); // owner only
		return array_map(fn (ShareEntity $s) => $s->jsonSerialize(), $this->shares->findForCollection($collectionId));
	}

	/**
	 * Share a collection with another user (owner only).
	 * $encKey/$encSalt: the owner's key wrapped with the share password (optional; enables secret viewing).
	 */
	public function addShare(string $ownerUid, int $collectionId, string $recipientUid, string $perm,
		?string $password, ?string $encKey, ?string $encSalt): array {
		$this->collections->findForUser($collectionId, $ownerUid); // owner only
		if ($recipientUid === $ownerUid) {
			throw new \RuntimeException('Cannot share with yourself');
		}
		if (!isset(self::PERM_RANK[$perm])) {
			$perm = self::PERM_VIEW;
		}
		if ($this->shares->findOne($collectionId, $recipientUid) !== null) {
			throw new \RuntimeException('Already shared with this user');
		}
		$s = new ShareEntity();
		$s->setCollectionId($collectionId);
		$s->setOwnerUid($ownerUid);
		$s->setRecipientUid($recipientUid);
		$s->setPerm($perm);
		$s->setPwHash(($password !== null && $password !== '') ? password_hash($password, PASSWORD_DEFAULT) : null);
		$s->setEncKey(($encKey !== null && $encKey !== '') ? $encKey : null);
		$s->setEncSalt(($encSalt !== null && $encSalt !== '') ? $encSalt : null);
		$s->setCreatedAt($this->now());
		return $this->shares->insert($s)->jsonSerialize();
	}

	/** Change a share's permission / password / wrapped key (owner only). */
	public function updateShare(string $ownerUid, int $collectionId, string $recipientUid, array $patch): array {
		$this->collections->findForUser($collectionId, $ownerUid); // owner only
		$s = $this->shares->findOne($collectionId, $recipientUid);
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
	public function removeShare(string $ownerUid, int $collectionId, string $recipientUid): void {
		$this->collections->findForUser($collectionId, $ownerUid); // owner only
		$s = $this->shares->findOne($collectionId, $recipientUid);
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
		$s = $this->shares->findOne($collectionId, $recipientUid);
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
