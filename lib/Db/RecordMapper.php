<?php

declare(strict_types=1);

namespace OCA\RegiBase\Db;

use OCA\RegiBase\Service\VersionJournal;
use OCP\AppFramework\Db\Entity;
use OCP\AppFramework\Db\QBMapper;
use OCP\DB\QueryBuilder\IQueryBuilder;
use OCP\IDBConnection;

/**
 * @extends QBMapper<RecordEntity>
 */
class RecordMapper extends QBMapper {
	public function __construct(IDBConnection $db, private VersionJournal $journal) {
		parent::__construct($db, 'regibase_records', RecordEntity::class);
	}

	/** The record as stored now, before a write (null if it is not there). */
	private function stored(int $id): ?array {
		$qb = $this->db->getQueryBuilder();
		$qb->select('*')->from($this->getTableName())
			->where($qb->expr()->eq('id', $qb->createNamedParameter($id, IQueryBuilder::PARAM_INT)));
		$r = $qb->executeQuery();
		$row = $r->fetch();
		$r->closeCursor();
		return $row ?: null;
	}

	// Every write goes through here, and the version of this session keeps what the
	// record was before it (VersionJournal). No way of changing a record is missed.
	public function insert(Entity $entity): Entity {
		$e = parent::insert($entity);
		$this->journal->added((int)$e->getCollectionId(), (int)$e->getId());
		return $e;
	}

	public function update(Entity $entity): Entity {
		$row = $this->stored((int)$entity->getId());
		if ($row !== null) {
			$this->journal->before($row);
		}
		return parent::update($entity);
	}

	public function delete(Entity $entity): Entity {
		$row = $this->stored((int)$entity->getId());
		if ($row !== null) {
			$this->journal->before($row);
		}
		$e = parent::delete($entity);
		if ($row !== null) {
			$this->journal->deleted((int)$row['collection_id'], (int)$row['id']);
		}
		return $e;
	}

	/** @return RecordEntity[] */
	public function findForCollection(int $collectionId): array {
		$qb = $this->db->getQueryBuilder();
		$qb->select('*')->from($this->getTableName())
			->where($qb->expr()->eq('collection_id', $qb->createNamedParameter($collectionId, IQueryBuilder::PARAM_INT)))
			->orderBy('sort', 'ASC')
			->addOrderBy('id', 'ASC');
		return $this->findEntities($qb);
	}

	/** Highest `sort` value in a collection (0 if empty) — used to append new records at the end. */
	public function maxSort(int $collectionId): int {
		$qb = $this->db->getQueryBuilder();
		$qb->select($qb->func()->max('sort'))->from($this->getTableName())
			->where($qb->expr()->eq('collection_id', $qb->createNamedParameter($collectionId, IQueryBuilder::PARAM_INT)));
		$r = $qb->executeQuery();
		$v = $r->fetchOne();
		$r->closeCursor();
		return (int)$v;
	}

	public function find(int $id): RecordEntity {
		$qb = $this->db->getQueryBuilder();
		$qb->select('*')->from($this->getTableName())
			->where($qb->expr()->eq('id', $qb->createNamedParameter($id, IQueryBuilder::PARAM_INT)));
		return $this->findEntity($qb);
	}

	public function countForCollection(int $collectionId): int {
		$qb = $this->db->getQueryBuilder();
		$qb->select($qb->func()->count('*'))->from($this->getTableName())
			->where($qb->expr()->eq('collection_id', $qb->createNamedParameter($collectionId, IQueryBuilder::PARAM_INT)));
		$r = $qb->executeQuery();
		$v = (int)$r->fetchOne();
		$r->closeCursor();
		return $v;
	}

	/**
	 * Write a record's data only if its updated_at is still $base, as one statement.
	 * @return int 1 when written, 0 when somebody saved in between
	 */
	public function updateIfUnchanged(RecordEntity $r, string $base): int {
		$row = $this->stored((int)$r->getId());
		if ($row !== null && (string)$row['updated_at'] === $base) {
			$this->journal->before($row);
		}
		$qb = $this->db->getQueryBuilder();
		$qb->update($this->getTableName())
			->set('data', $qb->createNamedParameter($r->getData()))
			->set('reading', $qb->createNamedParameter($r->getReading()))
			->set('updated_at', $qb->createNamedParameter($r->getUpdatedAt()))
			->where($qb->expr()->eq('id', $qb->createNamedParameter((int)$r->getId(), IQueryBuilder::PARAM_INT)))
			->andWhere($qb->expr()->eq('updated_at', $qb->createNamedParameter($base)));
		return $qb->executeStatement();
	}

	public function deleteForCollection(int $collectionId): void {
		$q = $this->db->getQueryBuilder();
		$q->select('*')->from($this->getTableName())
			->where($q->expr()->eq('collection_id', $q->createNamedParameter($collectionId, IQueryBuilder::PARAM_INT)));
		$rs = $q->executeQuery();
		$rows = $rs->fetchAll();
		$rs->closeCursor();
		foreach ($rows as $row) {
			$this->journal->before($row);
		}
		$qb = $this->db->getQueryBuilder();
		$qb->delete($this->getTableName())
			->where($qb->expr()->eq('collection_id', $qb->createNamedParameter($collectionId, IQueryBuilder::PARAM_INT)));
		$qb->executeStatement();
		foreach ($rows as $row) {
			$this->journal->deleted($collectionId, (int)$row['id']);
		}
	}
}
