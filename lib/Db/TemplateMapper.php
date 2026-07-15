<?php

declare(strict_types=1);

namespace OCA\RegiBase\Db;

use OCP\AppFramework\Db\QBMapper;
use OCP\DB\QueryBuilder\IQueryBuilder;
use OCP\IDBConnection;

/**
 * @extends QBMapper<TemplateEntity>
 */
class TemplateMapper extends QBMapper {
	public function __construct(IDBConnection $db) {
		parent::__construct($db, 'regibase_templates', TemplateEntity::class);
	}

	/** @return TemplateEntity[] */
	public function findAllForUser(string $userId): array {
		$qb = $this->db->getQueryBuilder();
		$qb->select('*')->from($this->getTableName())
			->where($qb->expr()->eq('user_id', $qb->createNamedParameter($userId)))
			->orderBy('sort', 'ASC')->addOrderBy('id', 'ASC');
		return $this->findEntities($qb);
	}

	public function findForUser(int $id, string $userId): TemplateEntity {
		$qb = $this->db->getQueryBuilder();
		$qb->select('*')->from($this->getTableName())
			->where($qb->expr()->eq('id', $qb->createNamedParameter($id, IQueryBuilder::PARAM_INT)))
			->andWhere($qb->expr()->eq('user_id', $qb->createNamedParameter($userId)));
		return $this->findEntity($qb);
	}

	/** The user's override row for a built-in key, or null. */
	public function findOverride(string $userId, string $builtinKey): ?TemplateEntity {
		$qb = $this->db->getQueryBuilder();
		$qb->select('*')->from($this->getTableName())
			->where($qb->expr()->eq('user_id', $qb->createNamedParameter($userId)))
			->andWhere($qb->expr()->eq('builtin_key', $qb->createNamedParameter($builtinKey)));
		try {
			return $this->findEntity($qb);
		} catch (\OCP\AppFramework\Db\DoesNotExistException $e) {
			return null;
		}
	}

	public function maxSort(string $userId): int {
		$qb = $this->db->getQueryBuilder();
		$qb->select($qb->func()->max('sort'))->from($this->getTableName())
			->where($qb->expr()->eq('user_id', $qb->createNamedParameter($userId)));
		$r = $qb->executeQuery();
		$v = (int)$r->fetchOne();
		$r->closeCursor();
		return $v;
	}
}
