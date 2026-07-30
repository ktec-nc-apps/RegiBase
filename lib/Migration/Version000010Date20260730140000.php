<?php

declare(strict_types=1);

namespace OCA\RegiBase\Migration;

use Closure;
use OCP\DB\ISchemaWrapper;
use OCP\DB\Types;
use OCP\Migration\IOutput;
use OCP\Migration\SimpleMigrationStep;

/**
 * Group sharing: a share row can now target a user OR a group. The existing
 * `recipient_uid` column holds the uid or the gid; `recipient_type` says which.
 * Existing rows default to 'user', so nothing changes for them.
 */
class Version000010Date20260730140000 extends SimpleMigrationStep {

	public function changeSchema(IOutput $output, Closure $schemaClosure, array $options): ?ISchemaWrapper {
		/** @var ISchemaWrapper $schema */
		$schema = $schemaClosure();

		if (!$schema->hasTable('regibase_shares')) {
			return $schema;
		}
		$t = $schema->getTable('regibase_shares');

		if (!$t->hasColumn('recipient_type')) {
			// 'user' | 'group'
			$t->addColumn('recipient_type', Types::STRING, ['notnull' => true, 'length' => 8, 'default' => 'user']);
		}

		// The uniqueness must now include the type (a user and a group may share
		// the same id string within one collection).
		if ($t->hasIndex('regibase_share_uniq')) {
			$t->dropIndex('regibase_share_uniq');
		}
		if (!$t->hasIndex('regibase_share_uniq2')) {
			$t->addUniqueIndex(['collection_id', 'recipient_uid', 'recipient_type'], 'regibase_share_uniq2');
		}

		return $schema;
	}
}
