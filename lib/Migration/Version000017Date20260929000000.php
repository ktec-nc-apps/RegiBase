<?php

declare(strict_types=1);

namespace OCA\RegiBase\Migration;

use Closure;
use OCP\DB\ISchemaWrapper;
use OCP\DB\Types;
use OCP\Migration\IOutput;
use OCP\Migration\SimpleMigrationStep;

/**
 * Versions by session (owner, 2026-09-29): a version of a collection begins with
 * the first record changed or deleted in it, and everything done until the browser
 * is closed or the user signs out belongs to it. The next session that changes or
 * deletes something begins the next version.
 *
 * A version keeps, for every record it touched, what the record was before it was
 * first touched in that session (kind "pre"), and which records it added (kind
 * "new"). Putting a collection back to before a version walks the versions from
 * the newest down to that one and puts each of those back.
 */
class Version000017Date20260929000000 extends SimpleMigrationStep {
	public function changeSchema(IOutput $output, Closure $schemaClosure, array $options): ?ISchemaWrapper {
		/** @var ISchemaWrapper $schema */
		$schema = $schemaClosure();
		if (!$schema->hasTable('regibase_versions')) {
			$t = $schema->createTable('regibase_versions');
			$t->addColumn('id', Types::BIGINT, ['autoincrement' => true, 'notnull' => true]);
			$t->addColumn('user_id', Types::STRING, ['notnull' => true, 'length' => 64]);
			$t->addColumn('collection_id', Types::BIGINT, ['notnull' => true]);
			$t->addColumn('session_key', Types::STRING, ['notnull' => true, 'length' => 160]);
			$t->addColumn('started_at', Types::STRING, ['notnull' => true, 'length' => 32]);
			$t->addColumn('updated_at', Types::STRING, ['notnull' => true, 'length' => 32]);
			$t->addColumn('fields_before', Types::TEXT, ['notnull' => false]);
			$t->setPrimaryKey(['id']);
			$t->addIndex(['collection_id', 'session_key'], 'rb_vers_coll_sess');
		}
		if (!$schema->hasTable('regibase_version_items')) {
			$t = $schema->createTable('regibase_version_items');
			$t->addColumn('id', Types::BIGINT, ['autoincrement' => true, 'notnull' => true]);
			$t->addColumn('version_id', Types::BIGINT, ['notnull' => true]);
			$t->addColumn('record_id', Types::BIGINT, ['notnull' => true]);
			$t->addColumn('kind', Types::STRING, ['notnull' => true, 'length' => 8]);
			$t->addColumn('deleted', Types::SMALLINT, ['notnull' => true, 'default' => 0]);
			$t->addColumn('data', Types::TEXT, ['notnull' => false]);
			$t->setPrimaryKey(['id']);
			$t->addUniqueIndex(['version_id', 'record_id'], 'rb_veritem_uniq');
		}
		return $schema;
	}
}
