<?php

declare(strict_types=1);

namespace OCA\RegiBase\Db;

use OCP\AppFramework\Db\Entity;

/**
 * @method string getUserId()
 * @method void setUserId(string $v)
 * @method string getName()
 * @method void setName(string $v)
 * @method string getIcon()
 * @method void setIcon(string $v)
 * @method string getColor()
 * @method void setColor(string $v)
 * @method ?string getDescription()
 * @method void setDescription(?string $v)
 * @method string getView()
 * @method void setView(string $v)
 * @method string getRecordSort()
 * @method void setRecordSort(string $v)
 * @method int getSort()
 * @method void setSort(int $v)
 * @method string getCreatedAt()
 * @method void setCreatedAt(string $v)
 * @method string getUpdatedAt()
 * @method void setUpdatedAt(string $v)
 * @method bool getLocked()
 * @method void setLocked(bool $v)
 * @method bool getKeyHead()
 * @method void setKeyHead(bool $v)
 * @method string getKeySep()
 * @method void setKeySep(string $v)
 * @method string getKeySepChar()
 * @method void setKeySepChar(string $v)
 * @method string getFilesFolder()
 * @method void setFilesFolder(string $v)
 * @method string getMapProvider()
 * @method void setMapProvider(string $v)
 */
class CollectionEntity extends Entity implements \JsonSerializable {
	protected $userId = '';
	protected $name = '';
	protected $icon = '📁';
	protected $color = '#3b82f6';
	protected $description = '';
	protected $view = 'list';
	protected $recordSort = 'created_desc';
	protected $sort = 0;
	protected $locked = false;
	protected $keyHead = false;
	protected $keySep = 'space';
	protected $keySepChar = '';
	protected $filesFolder = '';
	protected $mapProvider = '';
	// Secret collection: hidden from the collection list until unlocked in the
	// session with the matching 6-digit key. secretHash is the bcrypt hash of that
	// key; it is never serialised to the client.
	protected $secret = false;
	protected $secretHash = null;
	protected $createdAt = '';
	protected $updatedAt = '';

	public function __construct() {
		$this->addType('sort', 'integer');
		$this->addType('locked', 'boolean');
		$this->addType('keyHead', 'boolean');
		$this->addType('secret', 'boolean');
	}

	public function jsonSerialize(): array {
		return [
			'id' => (int)$this->id,
			'name' => $this->name,
			'icon' => $this->icon,
			'color' => $this->color,
			'description' => $this->description ?? '',
			'view' => $this->view,
			'record_sort' => $this->recordSort,
			'locked' => (bool)$this->locked,
			'key_head' => (bool)$this->keyHead,
			'key_sep' => $this->keySep,
			'key_sep_char' => $this->keySepChar,
			'files_folder' => $this->filesFolder ?? '',
			'map_provider' => $this->mapProvider ?? '',
			// only the flag is exposed — never the hash of the secret key
			'secret' => (bool)$this->secret,
			'created_at' => $this->createdAt,
			'updated_at' => $this->updatedAt,
		];
	}
}
