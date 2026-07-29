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

	/** @return HistoryEntity[] newest first */
	public function listForUser(string $userId, int $limit = 200): array {
		$qb = $this->db->getQueryBuilder();
		$qb->select('*')->from($this->getTableName())
			->where($qb->expr()->eq('user_id', $qb->createNamedParameter($userId)))
			->orderBy('id', 'DESC')
			->setMaxResults($limit);
		return $this->findEntities($qb);
	}

	/** The newest not-yet-undone entry, or null. */
	public function latestActive(string $userId): ?HistoryEntity {
		$qb = $this->db->getQueryBuilder();
		$qb->select('*')->from($this->getTableName())
			->where($qb->expr()->eq('user_id', $qb->createNamedParameter($userId)))
			->andWhere($qb->expr()->orX(
				$qb->expr()->isNull('undone'),
				$qb->expr()->eq('undone', $qb->createNamedParameter(false, IQueryBuilder::PARAM_BOOL))
			))
			->orderBy('id', 'DESC')
			->setMaxResults(1);
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

	public function deleteAllForUser(string $userId): void {
		$qb = $this->db->getQueryBuilder();
		$qb->delete($this->getTableName())
			->where($qb->expr()->eq('user_id', $qb->createNamedParameter($userId)));
		$qb->executeStatement();
	}
}
