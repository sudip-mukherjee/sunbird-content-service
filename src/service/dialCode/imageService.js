var async = require('async')
var _ = require('lodash')
var path = require('path')
var fs = require('fs')
var fx = require('mkdir-recursive')
var LOG = require('sb_logger_util')
var ColorUtil = require('./../../utils/colorUtil')
var QRCodeUtil = require('./../../utils/qrCodeUtil')
var qrCodeUtil = new QRCodeUtil()
var dbModel = require('./../../utils/cassandraUtil')
var UploadUtil = require('./../../utils/uploadUtil')
var uploadUtil = new UploadUtil()
var colorConvert = new ColorUtil()
var currentFile = path.basename(__filename)
var errorCorrectionLevels = ['L', 'M', 'Q', 'H']

function ImageService (config) {
  this.color = config && config.color ? colorConvert.cmykTohex(config.color) : '#000'
  this.backgroundColor = config && config.backgroundColor ? config.backgroundColor : '#ffff'
  this.width = config && config.width ? config.width : '30'
  this.height = config && config.height ? config.height : '30'
  this.margin = config && config.margin ? config.margin : '2'
  this.border = config && (config.border === 'false') ? '0' : '20'
  this.showText = config && (config.showText === 'false') ? '0' : '1'
  this.errCorrectionLevel = (config && config.errCorrectionLevel && _.indexOf(errorCorrectionLevels, config.errCorrectionLevel) !== -1) ? config.errCorrectionLevel : 'H'
}

ImageService.prototype.getImage = function generateImage (dialcode, channel, publisher, localFilePath, uploadFilePath, deleteLocalFileFlag, cb) {
  var self = this
  var config = self.getConfig()

  var localFileLocation = localFilePath || path.join(process.env.dial_code_image_temp_folder, channel, publisher)
  var uploadFileLocaton = uploadFilePath || path.join(channel, publisher)
  if (deleteLocalFileFlag !== false) {
    deleteLocalFileFlag = true
  }
  // check in cassendra return
  this.getImgFromDB(dialcode, channel, publisher, function (error, images) {
    var image = compareImageConfig(images, self.configToString())
    if (!error && image && image.url) {
      LOG.info({'Image Status:': 'avialable', url: image.url})
      cb(null, {url: image.url, 'created': false})
    } else {
      async.waterfall([
        function (callback) {
          // insert with 1 status
          self.insertImg(dialcode, channel, publisher, callback)
        },
        function (fileName, callback) {
        // genratate Image
          self.fileName = fileName
          var text = process.env.sunbird_dial_code_registry_url + dialcode
          var color = config.color
          var bgColor = config.backgroundColor
          var errCorrectionLevel = config.errCorrectionLevel
          var margin = config.margin
          try {
            if (!fs.existsSync(localFileLocation)) {
              fx.mkdirSync(localFileLocation)
            }
          } catch (e) {
            LOG.error({currentFile, 'unable create directory': e, directoryPath: localFileLocation})
          }

          qrCodeUtil.generate(path.join(localFileLocation, fileName + '.png'), text, color, bgColor, errCorrectionLevel, margin, callback)
        },
        function (filePath, callback) {
          var text = config.showText ? dialcode.trim() : ''
          qrCodeUtil.addTextAndBorder(filePath, text, config.border, config.color, callback)
        },
        function (filePath, callback) {
            // resize image
          qrCodeUtil.resize(filePath, config.width, config.height, callback)
        },
        function (filePath, callback) {
           // upload image

          var destFilePath = uploadFileLocaton ? path.join(uploadFileLocaton, self.fileName + '.png') : filePath
          uploadUtil.uploadFile(destFilePath, filePath, function (error, result) {
            if (error) {
              LOG.error({currentFile, 'Error uploading file': error, filePath, destFilePath})
            } else {
              LOG.info({currentFile, 'Uploading file': 'success', filePath, destFilePath})
            }
            callback(error, filePath, process.env.sunbird_image_storage_url + destFilePath)
          })
        },
        function (filePath, fileUrl, callback) {
          dbModel.instance.dialcode_images.update(
              {filename: self.fileName},
              {url: fileUrl, status: 2}, function (err) {
                callback(err, filePath, fileUrl)
              })
        },
        function (filePath, fileUrl, callback) {
           // delete local image
          if (deleteLocalFileFlag) {
            try {
              fs.unlinkSync(filePath)
            } catch (e) {
              LOG.error({'unable delete local file ': e})
            }
          }
          callback(null, fileUrl)
        }
      ], function (err, fileUrl) {
        cb(err, {url: fileUrl, 'created': true})
      })
    }
  })

  // add Text and border
  // resize
  // upload to storage system
  // update status to 2 and url
  // return url
}

ImageService.prototype.setConfig = function (config) {
  this.color = config && config.color ? colorConvert.cmykTohex(config.color) : '#000'
  this.backgroundColor = config && config.backgroundColor ? config.backgroundColor : '#ffff'
  this.width = config && config.width ? config.width : '30'
  this.height = config && config.height ? config.height : '30'
  this.margin = config && config.margin ? config.margin : '2'
  this.border = config && (config.border === 'false') ? '0' : '20'
  this.showText = config && (config.showText === 'false') ? '0' : '1'
  this.errCorrectionLevel = config && config.quality && _.indexOf(errorCorrectionLevels, config.quality) ? config.quality : 'H'
}

ImageService.prototype.getConfig = function () {
  return {
    color: this.color,
    backgroundColor: this.backgroundColor,
    width: parseInt(this.width),
    height: parseInt(this.height),
    margin: parseInt(this.margin),
    border: parseInt(this.border),
    showText: parseInt(this.showText),
    errCorrectionLevel: this.errCorrectionLevel
  }
}

ImageService.prototype.getImgFromDB = function (dialcode, channel, publisher, callback) {
  dbModel.instance.dialcode_images.find(
    {
      dialcode: dialcode,
      status: 2,
      channel: channel,
      publisher: publisher
    },
    {allow_filtering: true},
    function (error, images) {
      if (error) {
        LOG.error({'Unable to query dial code images before creating one : ': error,
          dialcode,
          channel,
          publisher
        })
      } else {
        LOG.info({'Querying dial code images before creating one : ': 'success',
          data: JSON.stringify(images),
          dialcode,
          channel,
          publisher
        })
      }
      callback(error, images)
    })
}

ImageService.prototype.insertImg = function (dialcode, channel, publisher, callback) {
  var fileName = dialcode + '_' + Date.now()
  var image = new dbModel.instance.dialcode_images({
    dialcode: dialcode,
    config: this.configToString(),
    status: 1,
    filename: fileName,
    channel: channel,
    publisher: publisher
  })
  image.save(function (error) {
    if (error) {
      LOG.error({'Unable to insert data to images table : ': error,
        dialcode,
        channel,
        publisher
      })
      callback(error, null)
    } else {
      LOG.info({'insering data to images table is : ': 'success',
        data: fileName,
        dialcode,
        channel,
        publisher
      })
      callback(error, fileName)
    }
  })
}

ImageService.prototype.configToString = function () {
  return _.mapValues(this.getConfig(), _.method('toString'))
}

var compareImageConfig = function (images, config) {
  var image = null
  _.forEach(images, function (img) {
    if (_.isEqual(img.config, config)) {
      image = img
      return false
    }
  })
  return image
}
module.exports = ImageService