<?php

declare(strict_types=1);

namespace OCA\RegiBase\Migration;

use Closure;
use OCP\DB\ISchemaWrapper;
use OCP\DB\QueryBuilder\IQueryBuilder;
use OCP\DB\Types;
use OCP\IConfig;
use OCP\IDBConnection;
use OCP\Migration\IOutput;
use OCP\Migration\SimpleMigrationStep;

/**
 * Per-collection attachment folder and map service.
 * - files_folder: Files-relative folder for this collection's images/files.
 *   Backfilled to "<owner base>/<collection name>" so existing attachments keep
 *   their current location and the field starts with the expected default.
 * - map_provider: overrides the global map service for this collection ('' = inherit).
 */
class Version000011Date20260730160000 extends SimpleMigrationStep {

	public function __construct(
		private IDBConnection $db,
		private IConfig $config,
	) {
	}

	public function changeSchema(IOutput $output, Closure $schemaClosure, array $options): ?ISchemaWrapper {
		/** @var ISchemaWrapper $schema */
		$schema = $schemaClosure();
		if (!$schema->hasTable('regibase_collections')) {
			return $schema;
		}
		$t = $schema->getTable('regibase_collections');
		// Nullable (no default): Nextcloud forbids a NOT NULL string column with an
		// empty-string default. NULL is read as '' by the entity.
		if (!$t->hasColumn('files_folder')) {
			$t->addColumn('files_folder', Types::STRING, ['notnull' => false, 'length' => 512]);
		}
		if (!$t->hasColumn('map_provider')) {
			$t->addColumn('map_provider', Types::STRING, ['notnull' => false, 'length' => 16]);
		}
		return $schema;
	}

	public function postSchemaChange(IOutput $output, Closure $schemaClosure, array $options): void {
		// Backfill files_folder for existing collections, preserving each owner's
		// current attachment location (<owner base folder>/<collection name>).
		$sel = $this->db->getQueryBuilder();
		$sel->select('id', 'user_id', 'name')->from('regibase_collections')
			->where($sel->expr()->orX(
				$sel->expr()->eq('files_folder', $sel->createNamedParameter('')),
				$sel->expr()->isNull('files_folder')
			));
		$res = $sel->executeQuery();
		$rows = $res->fetchAll();
		$res->closeCursor();
		foreach ($rows as $row) {
			$base = trim((string)$this->config->getUserValue((string)$row['user_id'], 'regibase', 'files_folder', 'RegiBase'));
			if ($base === '') {
				$base = 'RegiBase';
			}
			$folder = $base . '/' . (string)$row['name'];
			$upd = $this->db->getQueryBuilder();
			$upd->update('regibase_collections')
				->set('files_folder', $upd->createNamedParameter($folder))
				->where($upd->expr()->eq('id', $upd->createNamedParameter((int)$row['id'], IQueryBuilder::PARAM_INT)));
			$upd->executeStatement();
		}
	}
}
