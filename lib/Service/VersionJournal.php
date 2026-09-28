<?php

declare(strict_types=1);

namespace OCA\RegiBase\Service;

use OCP\DB\QueryBuilder\IQueryBuilder;
use OCP\IDBConnection;
use OCP\IRequest;
use OCP\ISession;
use OCP\IUserSession;

/**
 * Versions by session (owner, 2026-09-29).
 *
 * A version of a collection begins with the first record changed or deleted in it,
 * and everything done until the browser is closed or the user signs out belongs to
 * it. The browser says which session it is in (a cookie that lives as long as the
 * browser, sent as X-RegiBase-Session); signing out of Nextcloud ends the PHP
 * session, and with it the tag that is added to it, so the next sign-in is a new
 * session even in the same browser.
 *
 * What is kept: for every record a version touches, the record as it was before it
 * was first touched in that session ("pre"), and every record it added ("new");
 * for a change to the fields, the fields as they were before. The record mapper
 * calls in here on every write, so no way of changing a record is missed.
 */
class VersionJournal {
	private bool $suspended = false;
	/** @var array<int,int> collection id => version id, for this request */
	private array $open = [];

	public function __construct(
		private IDBConnection $db,
		private IRequest $request,
		private IUserSession $userSession,
		private ISession $session,
	) {
	}

	/** While a version is being put back, what that writes is not itself a change to keep. */
	public function suspend(bool $on): void {
		$this->suspended = $on;
	}

	private function uid(): ?string {
		$u = $this->userSession->getUser();
		return $u ? $u->getUID() : null;
	}

	/** Which session this request belongs to, or null when there is none to tell. */
	private function sessionKey(): ?string {
		$browser = (string)$this->request->getHeader('X-RegiBase-Session');
		if (!preg_match('/^[A-Za-z0-9-]{8,64}$/', $browser)) {
			return null;
		}
		$tag = $this->session->get('regibase_device_tag');
		if (!is_string($tag) || $tag === '') {
			$tag = bin2hex(random_bytes(16));
			$this->session->set('regibase_device_tag', $tag);
		}
		return $browser . ':' . $tag;
	}

	private function now(): string {
		return gmdate('Y-m-d\TH:i:s\Z');
	}

	/** The version this session is writing for a collection, begun if need be. */
	private function versionFor(int $collectionId, bool $begin = true): ?int {
		if ($this->suspended || $collectionId <= 0) {
			return null;
		}
		if (isset($this->open[$collectionId])) {
			return $this->open[$collectionId];
		}
		$uid = $this->uid();
		$key = $this->sessionKey();
		if ($uid === null || $key === null) {
			return null;
		}
		$qb = $this->db->getQueryBuilder();
		$qb->select('id')->from('regibase_versions')
			->where($qb->expr()->eq('collection_id', $qb->createNamedParameter($collectionId, IQueryBuilder::PARAM_INT)))
			->andWhere($qb->expr()->eq('session_key', $qb->createNamedParameter($key)))
			->andWhere($qb->expr()->eq('user_id', $qb->createNamedParameter($uid)))
			->setMaxResults(1);
		$r = $qb->executeQuery();
		$id = $r->fetchOne();
		$r->closeCursor();
		if ($id === false && !$begin) {
			return null;
		}
		if ($id === false) {
			$ins = $this->db->getQueryBuilder();
			$now = $this->now();
			$ins->insert('regibase_versions')->values([
				'user_id' => $ins->createNamedParameter($uid),
				'collection_id' => $ins->createNamedParameter($collectionId, IQueryBuilder::PARAM_INT),
				'session_key' => $ins->createNamedParameter($key),
				'started_at' => $ins->createNamedParameter($now),
				'updated_at' => $ins->createNamedParameter($now),
			]);
			$ins->executeStatement();
			$id = $ins->getLastInsertId();
		} else {
			$up = $this->db->getQueryBuilder();
			$up->update('regibase_versions')->set('updated_at', $up->createNamedParameter($this->now()))
				->where($up->expr()->eq('id', $up->createNamedParameter((int)$id, IQueryBuilder::PARAM_INT)));
			$up->executeStatement();
		}
		return $this->open[$collectionId] = (int)$id;
	}

	private function itemExists(int $versionId, int $recordId): bool {
		$qb = $this->db->getQueryBuilder();
		$qb->select('id')->from('regibase_version_items')
			->where($qb->expr()->eq('version_id', $qb->createNamedParameter($versionId, IQueryBuilder::PARAM_INT)))
			->andWhere($qb->expr()->eq('record_id', $qb->createNamedParameter($recordId, IQueryBuilder::PARAM_INT)))
			->setMaxResults(1);
		$r = $qb->executeQuery();
		$v = $r->fetchOne();
		$r->closeCursor();
		return $v !== false;
	}

	private function addItem(int $versionId, int $recordId, string $kind, ?string $data): void {
		$qb = $this->db->getQueryBuilder();
		$qb->insert('regibase_version_items')->values([
			'version_id' => $qb->createNamedParameter($versionId, IQueryBuilder::PARAM_INT),
			'record_id' => $qb->createNamedParameter($recordId, IQueryBuilder::PARAM_INT),
			'kind' => $qb->createNamedParameter($kind),
			'deleted' => $qb->createNamedParameter(0, IQueryBuilder::PARAM_INT),
			'data' => $qb->createNamedParameter($data),
		]);
		$qb->executeStatement();
	}

	/**
	 * A record is about to change or go: keep it as it is now, the first time this
	 * version touches it. $row is the record as stored (from the database, not the
	 * entity about to be written).
	 */
	public function before(array $row): void {
		$vid = $this->versionFor((int)($row['collection_id'] ?? 0));
		$rid = (int)($row['id'] ?? 0);
		if ($vid === null || $rid <= 0 || $this->itemExists($vid, $rid)) {
			return;
		}
		$this->addItem($vid, $rid, 'pre', json_encode([
			'data' => (string)($row['data'] ?? '{}'),
			'reading' => (string)($row['reading'] ?? ''),
			'sort' => (int)($row['sort'] ?? 0),
			'created_at' => (string)($row['created_at'] ?? ''),
			'updated_at' => (string)($row['updated_at'] ?? ''),
		], JSON_UNESCAPED_UNICODE));
	}

	/** A record has gone (it was kept by before() first). */
	public function deleted(int $collectionId, int $recordId): void {
		$vid = $this->versionFor($collectionId);
		if ($vid === null) {
			return;
		}
		$qb = $this->db->getQueryBuilder();
		$qb->update('regibase_version_items')->set('deleted', $qb->createNamedParameter(1, IQueryBuilder::PARAM_INT))
			->where($qb->expr()->eq('version_id', $qb->createNamedParameter($vid, IQueryBuilder::PARAM_INT)))
			->andWhere($qb->expr()->eq('record_id', $qb->createNamedParameter($recordId, IQueryBuilder::PARAM_INT)));
		$qb->executeStatement();
	}

	/** A record was added. Only counted once a version has begun (a change or a deletion). */
	public function added(int $collectionId, int $recordId): void {
		$vid = $this->versionFor($collectionId, false);
		if ($vid === null || $this->itemExists($vid, $recordId)) {
			return;
		}
		$this->addItem($vid, $recordId, 'new', null);
	}

	/** The fields of a collection are about to change: keep them, once per version. */
	public function fieldsBefore(int $collectionId, array $fieldsJson): void {
		$vid = $this->versionFor($collectionId);
		if ($vid === null) {
			return;
		}
		$qb = $this->db->getQueryBuilder();
		$qb->update('regibase_versions')->set('fields_before', $qb->createNamedParameter(json_encode($fieldsJson, JSON_UNESCAPED_UNICODE)))
			->where($qb->expr()->eq('id', $qb->createNamedParameter($vid, IQueryBuilder::PARAM_INT)))
			->andWhere($qb->expr()->isNull('fields_before'));
		$qb->executeStatement();
	}

	/** @return array<int,array> the versions of a collection, newest first, with what each did */
	public function listFor(int $collectionId): array {
		$qb = $this->db->getQueryBuilder();
		$qb->select('*')->from('regibase_versions')
			->where($qb->expr()->eq('collection_id', $qb->createNamedParameter($collectionId, IQueryBuilder::PARAM_INT)))
			->orderBy('id', 'DESC');
		$r = $qb->executeQuery();
		$rows = $r->fetchAll();
		$r->closeCursor();
		$current = $this->sessionKey();
		$out = [];
		foreach ($rows as $v) {
			$c = $this->db->getQueryBuilder();
			$c->select('kind', 'deleted')->from('regibase_version_items')
				->where($c->expr()->eq('version_id', $c->createNamedParameter((int)$v['id'], IQueryBuilder::PARAM_INT)));
			$rr = $c->executeQuery();
			$changed = $deleted = $added = 0;
			foreach ($rr->fetchAll() as $it) {
				if ($it['kind'] === 'new') {
					if (!(int)$it['deleted']) {
						$added++;
					}
				} elseif ((int)$it['deleted']) {
					$deleted++;
				} else {
					$changed++;
				}
			}
			$rr->closeCursor();
			$out[] = [
				'id' => (int)$v['id'],
				'user_id' => (string)$v['user_id'],
				'started_at' => (string)$v['started_at'],
				'updated_at' => (string)$v['updated_at'],
				'changed' => $changed, 'deleted' => $deleted, 'added' => $added,
				'fields' => $v['fields_before'] !== null,
				'current' => $current !== null && $v['session_key'] === $current,
			];
		}
		return $out;
	}

	/** @return array<int,array> the versions of a collection from $versionId up, newest first, with their items */
	public function fromUp(int $collectionId, int $versionId): array {
		$qb = $this->db->getQueryBuilder();
		$qb->select('*')->from('regibase_versions')
			->where($qb->expr()->eq('collection_id', $qb->createNamedParameter($collectionId, IQueryBuilder::PARAM_INT)))
			->andWhere($qb->expr()->gte('id', $qb->createNamedParameter($versionId, IQueryBuilder::PARAM_INT)))
			->orderBy('id', 'DESC');
		$r = $qb->executeQuery();
		$vers = $r->fetchAll();
		$r->closeCursor();
		foreach ($vers as &$v) {
			$i = $this->db->getQueryBuilder();
			$i->select('*')->from('regibase_version_items')
				->where($i->expr()->eq('version_id', $i->createNamedParameter((int)$v['id'], IQueryBuilder::PARAM_INT)))
				->orderBy('id', 'DESC');
			$ri = $i->executeQuery();
			$v['items'] = $ri->fetchAll();
			$ri->closeCursor();
		}
		return $vers;
	}

	/** The versions from $versionId up are gone once they have been put back. */
	public function dropFromUp(int $collectionId, int $versionId): void {
		foreach ($this->fromUp($collectionId, $versionId) as $v) {
			$d = $this->db->getQueryBuilder();
			$d->delete('regibase_version_items')->where($d->expr()->eq('version_id', $d->createNamedParameter((int)$v['id'], IQueryBuilder::PARAM_INT)));
			$d->executeStatement();
			$d = $this->db->getQueryBuilder();
			$d->delete('regibase_versions')->where($d->expr()->eq('id', $d->createNamedParameter((int)$v['id'], IQueryBuilder::PARAM_INT)));
			$d->executeStatement();
		}
		$this->open = [];
	}

	/**
	 * A record put back by restoring comes back under a new id. The older versions
	 * of the collection still name it by the old one: they are told the new one, or
	 * putting one of them back later would bring the record back a second time.
	 */
	public function renumber(int $collectionId, int $oldId, int $newId): void {
		$qb = $this->db->getQueryBuilder();
		$qb->select('id')->from('regibase_versions')
			->where($qb->expr()->eq('collection_id', $qb->createNamedParameter($collectionId, IQueryBuilder::PARAM_INT)));
		$r = $qb->executeQuery();
		$ids = array_map('intval', array_column($r->fetchAll(), 'id'));
		$r->closeCursor();
		if (!$ids) {
			return;
		}
		$u = $this->db->getQueryBuilder();
		$u->update('regibase_version_items')->set('record_id', $u->createNamedParameter($newId, IQueryBuilder::PARAM_INT))
			->where($u->expr()->eq('record_id', $u->createNamedParameter($oldId, IQueryBuilder::PARAM_INT)))
			->andWhere($u->expr()->in('version_id', $u->createNamedParameter($ids, IQueryBuilder::PARAM_INT_ARRAY)));
		$u->executeStatement();
	}

	/** A record this version deleted went to another collection, as record $targetId there. */
	public function movedTo(int $collectionId, int $recordId, int $targetId): void {
		$vid = $this->versionFor($collectionId, false);
		if ($vid === null) {
			return;
		}
		$qb = $this->db->getQueryBuilder();
		$qb->select('id', 'data')->from('regibase_version_items')
			->where($qb->expr()->eq('version_id', $qb->createNamedParameter($vid, IQueryBuilder::PARAM_INT)))
			->andWhere($qb->expr()->eq('record_id', $qb->createNamedParameter($recordId, IQueryBuilder::PARAM_INT)));
		$r = $qb->executeQuery();
		$row = $r->fetch();
		$r->closeCursor();
		if (!$row) {
			return;
		}
		$d = json_decode((string)$row['data'], true) ?: [];
		$d['moved_to'] = $targetId;
		$u = $this->db->getQueryBuilder();
		$u->update('regibase_version_items')->set('data', $u->createNamedParameter(json_encode($d, JSON_UNESCAPED_UNICODE)))
			->where($u->expr()->eq('id', $u->createNamedParameter((int)$row['id'], IQueryBuilder::PARAM_INT)));
		$u->executeStatement();
	}

	/** @return array<int,array> the record data every version of a collection still keeps */
	public function heldData(int $collectionId): array {
		$qb = $this->db->getQueryBuilder();
		$qb->select('i.data')->from('regibase_version_items', 'i')
			->innerJoin('i', 'regibase_versions', 'v', $qb->expr()->eq('v.id', 'i.version_id'))
			->where($qb->expr()->eq('v.collection_id', $qb->createNamedParameter($collectionId, IQueryBuilder::PARAM_INT)))
			->andWhere($qb->expr()->eq('i.kind', $qb->createNamedParameter('pre')));
		$r = $qb->executeQuery();
		$out = [];
		foreach ($r->fetchAll() as $row) {
			$pre = json_decode((string)$row['data'], true) ?: [];
			$out[] = json_decode((string)($pre['data'] ?? '{}'), true) ?: [];
		}
		$r->closeCursor();
		return $out;
	}

	/** Every version of these collections goes (a backup put back in their place). */
	public function dropForCollections(array $collectionIds): void {
		foreach ($collectionIds as $cid) {
			$qb = $this->db->getQueryBuilder();
			$qb->select('id')->from('regibase_versions')
				->where($qb->expr()->eq('collection_id', $qb->createNamedParameter((int)$cid, IQueryBuilder::PARAM_INT)));
			$r = $qb->executeQuery();
			$ids = array_map('intval', array_column($r->fetchAll(), 'id'));
			$r->closeCursor();
			foreach ($ids as $vid) {
				$d = $this->db->getQueryBuilder();
				$d->delete('regibase_version_items')->where($d->expr()->eq('version_id', $d->createNamedParameter($vid, IQueryBuilder::PARAM_INT)));
				$d->executeStatement();
				$d = $this->db->getQueryBuilder();
				$d->delete('regibase_versions')->where($d->expr()->eq('id', $d->createNamedParameter($vid, IQueryBuilder::PARAM_INT)));
				$d->executeStatement();
			}
		}
		$this->open = [];
	}
}
