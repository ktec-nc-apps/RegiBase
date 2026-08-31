<?php

declare(strict_types=1);

namespace OCA\RegiBase\Db;

use OCP\AppFramework\Db\QBMapper;
use OCP\DB\QueryBuilder\IQueryBuilder;
use OCP\IDBConnection;

/**
 * @extends QBMapper<RecordVersionEntity>
 */
class RecordVersionMapper extends QBMapper {
	public function __construct(IDBConnection $db) {
		parent::__construct($db, 'regibase_rec_vers', RecordVersionEntity::class);
	}

	public function findByRecordAndNumber(int $recordId, int $number): ?RecordVersionEntity {
		$qb = $this->db->getQueryBuilder();
		$qb->select('*')->from($this->getTableName())
			->where($qb->expr()->eq('record_id', $qb->createNamedParameter($recordId, IQueryBuilder::PARAM_INT)))
			->andWhere($qb->expr()->eq('number', $qb->createNamedParameter($number, IQueryBuilder::PARAM_INT)));
		$rows = $this->findEntities($qb);
		return $rows[0] ?? null;
	}

	/** @return RecordVersionEntity[] a record's versions, newest (lowest number) first */
	public function listForRecord(int $recordId): array {
		$qb = $this->db->getQueryBuilder();
		$qb->select('*')->from($this->getTableName())
			->where($qb->expr()->eq('record_id', $qb->createNamedParameter($recordId, IQueryBuilder::PARAM_INT)))
			->orderBy('number', 'ASC');
		return $this->findEntities($qb);
	}

	/** Delete every version of a record numbered $fromNumber or higher (the ones past the keep limit). */
	public function deleteFromNumber(int $recordId, int $fromNumber): void {
		$qb = $this->db->getQueryBuilder();
		$qb->delete($this->getTableName())
			->where($qb->expr()->eq('record_id', $qb->createNamedParameter($recordId, IQueryBuilder::PARAM_INT)))
			->andWhere($qb->expr()->gte('number', $qb->createNamedParameter($fromNumber, IQueryBuilder::PARAM_INT)));
		$qb->executeStatement();
	}

	public function deleteAllForRecord(int $recordId): void {
		$qb = $this->db->getQueryBuilder();
		$qb->delete($this->getTableName())
			->where($qb->expr()->eq('record_id', $qb->createNamedParameter($recordId, IQueryBuilder::PARAM_INT)));
		$qb->executeStatement();
	}
}
