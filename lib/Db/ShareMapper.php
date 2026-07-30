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

	/** All user-type shares granted TO a recipient uid. @return ShareEntity[] */
	public function findForRecipient(string $recipientUid): array {
		$qb = $this->db->getQueryBuilder();
		$qb->select('*')->from($this->getTableName())
			->where($qb->expr()->eq('recipient_uid', $qb->createNamedParameter($recipientUid)))
			->andWhere($qb->expr()->eq('recipient_type', $qb->createNamedParameter('user')));
		return $this->findEntities($qb);
	}

	/**
	 * Predicate matching every share a user can reach: their own user-share, plus
	 * group-shares for any group they belong to. Reused by the per-collection and
	 * cross-collection access queries below.
	 */
	private function accessPredicate(IQueryBuilder $qb, string $userId, array $groupIds) {
		$ors = $qb->expr()->orX(
			$qb->expr()->andX(
				$qb->expr()->eq('recipient_type', $qb->createNamedParameter('user')),
				$qb->expr()->eq('recipient_uid', $qb->createNamedParameter($userId))
			)
		);
		if (!empty($groupIds)) {
			$ors->add($qb->expr()->andX(
				$qb->expr()->eq('recipient_type', $qb->createNamedParameter('group')),
				$qb->expr()->in('recipient_uid', $qb->createNamedParameter($groupIds, IQueryBuilder::PARAM_STR_ARRAY))
			));
		}
		return $ors;
	}

	/** Shares of ONE collection that grant access to $userId (direct or via a group). @return ShareEntity[] */
	public function findForUserAccess(int $collectionId, string $userId, array $groupIds): array {
		$qb = $this->db->getQueryBuilder();
		$qb->select('*')->from($this->getTableName())
			->where($qb->expr()->eq('collection_id', $qb->createNamedParameter($collectionId, IQueryBuilder::PARAM_INT)))
			->andWhere($this->accessPredicate($qb, $userId, $groupIds));
		return $this->findEntities($qb);
	}

	/** Every share (any collection) that grants access to $userId (direct or via a group). @return ShareEntity[] */
	public function findAllForUserAccess(string $userId, array $groupIds): array {
		$qb = $this->db->getQueryBuilder();
		$qb->select('*')->from($this->getTableName())
			->where($this->accessPredicate($qb, $userId, $groupIds));
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

	/** The share row for (collection, recipient, type), or null. */
	public function findOne(int $collectionId, string $recipientUid, string $recipientType = 'user'): ?ShareEntity {
		$qb = $this->db->getQueryBuilder();
		$qb->select('*')->from($this->getTableName())
			->where($qb->expr()->eq('collection_id', $qb->createNamedParameter($collectionId, IQueryBuilder::PARAM_INT)))
			->andWhere($qb->expr()->eq('recipient_uid', $qb->createNamedParameter($recipientUid)))
			->andWhere($qb->expr()->eq('recipient_type', $qb->createNamedParameter($recipientType)));
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
