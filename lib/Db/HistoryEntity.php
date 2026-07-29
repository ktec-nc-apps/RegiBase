<?php

declare(strict_types=1);

namespace OCA\RegiBase\Db;

use OCP\AppFramework\Db\Entity;

/**
 * @method string getUserId()
 * @method void setUserId(string $v)
 * @method string getOp()
 * @method void setOp(string $v)
 * @method ?int getCollectionId()
 * @method void setCollectionId(?int $v)
 * @method string getSummary()
 * @method void setSummary(string $v)
 * @method ?string getGrp()
 * @method void setGrp(?string $v)
 * @method ?string getUndoData()
 * @method void setUndoData(?string $v)
 * @method bool getUndone()
 * @method void setUndone(bool $v)
 * @method string getCreatedAt()
 * @method void setCreatedAt(string $v)
 */
class HistoryEntity extends Entity implements \JsonSerializable {
	protected $userId = '';
	protected $op = '';
	protected $collectionId = null;
	protected $summary = '';
	protected $grp = null;
	protected $undoData = null;
	protected $undone = false;
	protected $createdAt = '';

	public function __construct() {
		$this->addType('collectionId', 'integer');
		$this->addType('undone', 'boolean');
	}

	/** History rows shown to the client never expose the raw inverse payload. */
	public function jsonSerialize(): array {
		return [
			'id' => (int)$this->id,
			'op' => $this->op,
			'collection_id' => $this->collectionId !== null ? (int)$this->collectionId : null,
			'summary' => $this->summary,
			'grp' => $this->grp,
			'undone' => (bool)$this->undone,
			'created_at' => $this->createdAt,
		];
	}
}
