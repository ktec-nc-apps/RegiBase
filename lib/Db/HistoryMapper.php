<?php

declare(strict_types=1);

namespace OCA\RegiBase\Db;

use OCP\AppFramework\Db\QBMapper;
use OCP\DB\QueryBuilder\IQueryBuilder;
use OCP\IDBConnection;

/**
 * @extends QBMapper<HistoryEntity>
 */
class HistoryMapper extends QBMapper {
	public function __construct(IDBConnection $db) {
		parent::__construct($db, 'regibase_history', HistoryEntity::class);
	}

	/** @return HistoryEntity[] newest first (optionally scoped to one collection) */
	public function listForUser(string $userId, int $limit = 200, ?int $collectionId = null): array {
		$qb = $this->db->getQueryBuilder();
		$qb->select('*')->from($this->getTableName())
			->where($qb->expr()->eq('user_id', $qb->createNamedParameter($userId)))
			->orderBy('id', 'DESC')
			->setMaxResults($limit);
		if ($collectionId !== null) {
			$qb->andWhere($qb->expr()->eq('collection_id', $qb->createNamedParameter($collectionId, IQueryBuilder::PARAM_INT)));
		}
		return $this->findEntities($qb);
	}

	/** The newest not-yet-undone entry (optionally within one collection), or null. */
	public function latestActive(string $userId, ?int $collectionId = null): ?HistoryEntity {
		$qb = $this->db->getQueryBuilder();
		$qb->select('*')->from($this->getTableName())
			->where($qb->expr()->eq('user_id', $qb->createNamedParameter($userId)))
			->andWhere($qb->expr()->orX(
				$qb->expr()->isNull('undone'),
				$qb->expr()->eq('undone', $qb->createNamedParameter(false, IQueryBuilder::PARAM_BOOL))
			))
			->orderBy('id', 'DESC')
			->setMaxResults(1);
		if ($collectionId !== null) {
			$qb->andWhere($qb->expr()->eq('collection_id', $qb->createNamedParameter($collectionId, IQueryBuilder::PARAM_INT)));
		}
		$rows = $this->findEntities($qb);
		return $rows[0] ?? null;
	}

	/** All not-yet-undone entries of one group, newest first. */
	public function activeGroup(string $userId, string $grp): array {
		$qb = $this->db->getQueryBuilder();
		$qb->select('*')->from($this->getTableName())
			->where($qb->expr()->eq('user_id', $qb->createNamedParameter($userId)))
			->andWhere($qb->expr()->eq('grp', $qb->createNamedParameter($grp)))
			->andWhere($qb->expr()->orX(
				$qb->expr()->isNull('undone'),
				$qb->expr()->eq('undone', $qb->createNamedParameter(false, IQueryBuilder::PARAM_BOOL))
			))
			->orderBy('id', 'DESC');
		return $this->findEntities($qb);
	}

	public function countActive(string $userId): int {
		$qb = $this->db->getQueryBuilder();
		$qb->select($qb->func()->count('*'))->from($this->getTableName())
			->where($qb->expr()->eq('user_id', $qb->createNamedParameter($userId)))
			->andWhere($qb->expr()->orX(
				$qb->expr()->isNull('undone'),
				$qb->expr()->eq('undone', $qb->createNamedParameter(false, IQueryBuilder::PARAM_BOOL))
			));
		$r = $qb->executeQuery();
		$v = (int)$r->fetchOne();
		$r->closeCursor();
		return $v;
	}

	/** Delete the oldest rows so at most $keep remain for the user. */
	public function pruneToLimit(string $userId, int $keep): void {
		$qb = $this->db->getQueryBuilder();
		$qb->select('id')->from($this->getTableName())
			->where($qb->expr()->eq('user_id', $qb->createNamedParameter($userId)))
			->orderBy('id', 'DESC')
			->setFirstResult(max(0, $keep))
			->setMaxResults(100000);
		$r = $qb->executeQuery();
		$ids = array_map('intval', array_column($r->fetchAll(), 'id'));
		$r->closeCursor();
		if (!$ids) {
			return;
		}
		$del = $this->db->getQueryBuilder();
		$del->delete($this->getTableName())
			->where($del->expr()->in('id', $del->createNamedParameter($ids, IQueryBuilder::PARAM_INT_ARRAY)));
		$del->executeStatement();
	}

	public function deleteAllForUser(string $userId, ?int $collectionId = null): void {
		$qb = $this->db->getQueryBuilder();
		$qb->delete($this->getTableName())
			->where($qb->expr()->eq('user_id', $qb->createNamedParameter($userId)));
		if ($collectionId !== null) {
			$qb->andWhere($qb->expr()->eq('collection_id', $qb->createNamedParameter($collectionId, IQueryBuilder::PARAM_INT)));
		}
		$qb->executeStatement();
	}

	/** Every snapshot of a collection, whoever made it, and the ones grouped with them elsewhere. */
	public function deleteForCollection(int $collectionId): void {
		// A move is kept in both collections as one group, and only one of the two
		// carries the undo. Left in the other collection, it would undo a move the
		// version already put back, and bring the records back a second time.
		$g = $this->db->getQueryBuilder();
		$g->selectDistinct('grp')->from($this->getTableName())
			->where($g->expr()->eq('collection_id', $g->createNamedParameter($collectionId, IQueryBuilder::PARAM_INT)))
			->andWhere($g->expr()->isNotNull('grp'));
		$r = $g->executeQuery();
		$grps = array_values(array_filter(array_column($r->fetchAll(), 'grp'), fn ($x) => (string)$x !== ''));
		$r->closeCursor();
		if ($grps) {
			$d = $this->db->getQueryBuilder();
			$d->delete($this->getTableName())
				->where($d->expr()->in('grp', $d->createNamedParameter($grps, IQueryBuilder::PARAM_STR_ARRAY)));
			$d->executeStatement();
		}
		$qb = $this->db->getQueryBuilder();
		$qb->delete($this->getTableName())
			->where($qb->expr()->eq('collection_id', $qb->createNamedParameter($collectionId, IQueryBuilder::PARAM_INT)));
		$qb->executeStatement();
	}
}
