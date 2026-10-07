<?php

declare(strict_types=1);

namespace OCA\RegiBase\Listener;

use OCP\DB\QueryBuilder\IQueryBuilder;
use OCP\EventDispatcher\Event;
use OCP\EventDispatcher\IEventListener;
use OCP\Group\Events\GroupDeletedEvent;
use OCP\IDBConnection;
use OCP\User\Events\UserDeletedEvent;
use Psr\Log\LoggerInterface;

/**
 * When an account goes, its RegiBase data goes with it: the collections it owns (fields,
 * records, record versions, versions by session, shares, and everybody's undo history for
 * them), its templates and its own history, and every share addressed to it. A deleted group loses the shares
 * addressed to it. Otherwise an account created later under the same uid/gid would inherit them.
 *
 * @template-implements IEventListener<Event>
 */
class AccountDeletedListener implements IEventListener {
	public function __construct(private IDBConnection $db, private LoggerInterface $logger) {
	}

	public function handle(Event $event): void {
		if ($event instanceof UserDeletedEvent) {
			$this->forUser($event->getUser()->getUID());
		} elseif ($event instanceof GroupDeletedEvent) {
			$this->forRecipient('group', $event->getGroup()->getGID());
		}
	}

	public function forUser(string $uid): void {
		$this->db->beginTransaction();
		try {
			$qb = $this->db->getQueryBuilder();
			$qb->select('id')->from('regibase_collections')->where($qb->expr()->eq('user_id', $qb->createNamedParameter($uid)));
			$cids = array_map('intval', $qb->executeQuery()->fetchAll(\PDO::FETCH_COLUMN));
			foreach (array_chunk($cids, 500) as $chunk) {
				$sub = $this->db->getQueryBuilder();
				$sub->select('id')->from('regibase_records')->where($sub->expr()->in('collection_id', $sub->createNamedParameter($chunk, IQueryBuilder::PARAM_INT_ARRAY)));
				$rids = array_map('intval', $sub->executeQuery()->fetchAll(\PDO::FETCH_COLUMN));
				foreach (array_chunk($rids, 1000) as $r) {
					$this->deleteIn('regibase_rec_vers', 'record_id', $r);
				}
				// the versions by session and what they keep (they stayed behind, review)
				$vq = $this->db->getQueryBuilder();
				$vq->select('id')->from('regibase_versions')->where($vq->expr()->in('collection_id', $vq->createNamedParameter($chunk, IQueryBuilder::PARAM_INT_ARRAY)));
				$vids = array_map('intval', $vq->executeQuery()->fetchAll(\PDO::FETCH_COLUMN));
				foreach (array_chunk($vids, 1000) as $v) {
					$this->deleteIn('regibase_version_items', 'version_id', $v);
				}
				foreach (['regibase_records', 'regibase_fields', 'regibase_shares', 'regibase_history', 'regibase_versions'] as $t) {
					$this->deleteIn($t, 'collection_id', $chunk);
				}
				$this->deleteIn('regibase_collections', 'id', $chunk);
			}
			foreach (['regibase_history', 'regibase_templates'] as $t) {
				$qb = $this->db->getQueryBuilder();
				$qb->delete($t)->where($qb->expr()->eq('user_id', $qb->createNamedParameter($uid)))->executeStatement();
			}
			$this->forRecipient('user', $uid);
			$this->db->commit();
		} catch (\Throwable $e) {
			$this->db->rollBack();
			$this->logger->error('RegiBase could not remove the data of deleted user ' . $uid, ['exception' => $e]);
		}
	}

	private function forRecipient(string $type, string $id): void {
		$qb = $this->db->getQueryBuilder();
		$qb->delete('regibase_shares')
			->where($qb->expr()->eq('recipient_type', $qb->createNamedParameter($type)))
			->andWhere($qb->expr()->eq('recipient_uid', $qb->createNamedParameter($id)))
			->executeStatement();
	}

	private function deleteIn(string $table, string $col, array $ids): void {
		if ($ids === []) {
			return;
		}
		$qb = $this->db->getQueryBuilder();
		$qb->delete($table)->where($qb->expr()->in($col, $qb->createNamedParameter($ids, IQueryBuilder::PARAM_INT_ARRAY)))->executeStatement();
	}
}
