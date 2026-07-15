<?php

declare(strict_types=1);

namespace OCA\RegiBase\Db;

use OCP\AppFramework\Db\Entity;

/**
 * @method int getCollectionId()
 * @method void setCollectionId(int $v)
 * @method string getOwnerUid()
 * @method void setOwnerUid(string $v)
 * @method string getRecipientUid()
 * @method void setRecipientUid(string $v)
 * @method string getPerm()
 * @method void setPerm(string $v)
 * @method ?string getPwHash()
 * @method void setPwHash(?string $v)
 * @method ?string getEncKey()
 * @method void setEncKey(?string $v)
 * @method ?string getEncSalt()
 * @method void setEncSalt(?string $v)
 * @method string getCreatedAt()
 * @method void setCreatedAt(string $v)
 */
class ShareEntity extends Entity implements \JsonSerializable {
	protected $collectionId = 0;
	protected $ownerUid = '';
	protected $recipientUid = '';
	protected $perm = 'view';
	protected $pwHash = null;
	protected $encKey = null;
	protected $encSalt = null;
	protected $createdAt = '';

	public function __construct() {
		$this->addType('collectionId', 'integer');
	}

	public function jsonSerialize(): array {
		return [
			'id' => (int)$this->id,
			'collection_id' => (int)$this->collectionId,
			'owner_uid' => $this->ownerUid,
			'recipient_uid' => $this->recipientUid,
			'perm' => $this->perm,
			// never expose the hash or wrapped key material; only whether they exist
			'has_password' => $this->pwHash !== null && $this->pwHash !== '',
			'shares_secrets' => $this->encKey !== null && $this->encKey !== '',
			'created_at' => $this->createdAt,
		];
	}
}
