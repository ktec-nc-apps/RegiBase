<?php

declare(strict_types=1);

namespace OCA\RegiBase\Db;

use OCP\AppFramework\Db\DoesNotExistException;
use OCP\AppFramework\Db\QBMapper;
use OCP\DB\QueryBuilder\IQueryBuilder;
use OCP\IDBConnection;

/**
 * @extends QBMapper<ShareEntity>
 */
class ShareMapper extends QBMapper {
	public function __construct(IDBConnection $db) {
		parent::__construct($db, 'regibase_shares', ShareEntity::class);
	}

	/** All shares granted TO a recipient. @return ShareEntity[] */
	public function findForRecipient(string $recipientUid): array {
		$qb = $this->db->getQueryBuilder();
		$qb->select('*')->from($this->getTableName())
			->where($qb->expr()->eq('recipient_uid', $qb->createNamedParameter($recipientUid)));
		return $this->findEntities($qb);
	}

	/** All shares of a collection (its recipients). @return ShareEntity[] */
	public function findForCollection(int $collectionId): array {
		$qb = $this->db->getQueryBuilder();
		$qb->select('*')->from($this->getTableName())
			->where($qb->expr()->eq('collection_id', $qb->createNamedParameter($collectionId, IQueryBuilder::PARAM_INT)))
			->orderBy('id', 'ASC');
		return $this->findEntities($qb);
	}

	/** The share row for (collection, recipient), or null. */
	public function findOne(int $collectionId, string $recipientUid): ?ShareEntity {
		$qb = $this->db->getQueryBuilder();
		$qb->select('*')->from($this->getTableName())
			->where($qb->expr()->eq('collection_id', $qb->createNamedParameter($collectionId, IQueryBuilder::PARAM_INT)))
			->andWhere($qb->expr()->eq('recipient_uid', $qb->createNamedParameter($recipientUid)));
		try {
			return $this->findEntity($qb);
		} catch (DoesNotExistException $e) {
			return null;
		}
	}

	/** Does the collection have any shares? */
	public function collectionIsShared(int $collectionId): bool {
		$qb = $this->db->getQueryBuilder();
		$qb->select($qb->func()->count('*'))->from($this->getTableName())
			->where($qb->expr()->eq('collection_id', $qb->createNamedParameter($collectionId, IQueryBuilder::PARAM_INT)));
		$r = $qb->executeQuery();
		$n = (int)$r->fetchOne();
		$r->closeCursor();
		return $n > 0;
	}

	public function deleteForCollection(int $collectionId): void {
		$qb = $this->db->getQueryBuilder();
		$qb->delete($this->getTableName())
			->where($qb->expr()->eq('collection_id', $qb->createNamedParameter($collectionId, IQueryBuilder::PARAM_INT)));
		$qb->executeStatement();
	}
}
