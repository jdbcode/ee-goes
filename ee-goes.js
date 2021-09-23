/**
 * @license
 * Copyright 2021 Google LLC.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

// #############################################################################
// ### VERSION ###
// #############################################################################

exports.version = '0.1.0';

// #############################################################################
// ### CONSTANTS ###
// #############################################################################

/**
 * A dictionary of GOES MCMIP true color visualization parameters for land.
 *
 * @constant {Object}
 */
var trueColorLand = {
  bands: ['CMI_C02', 'GREEN', 'CMI_C01'],
  min: 0,
  max: 0.35,
  gamma: 1,
};
exports.trueColorLand = trueColorLand;

/**
 * A dictionary of GOES MCMIP true color visualization parameters for cloud.
 *
 * @constant {Object}
 */
var trueColorCloud = {
  bands: ['CMI_C02', 'GREEN', 'CMI_C01'],
  min: 0,
  max: 1,  // 1.3
  gamma: 1.3
};
exports.trueColorCloud = trueColorCloud;

// #############################################################################
// ### FUNCTIONS ###
// #############################################################################

/**
 * Updates default parameters with user-defined parameters.
 *
 * @param {Object} update User-defined parameters.
 * @param {Object} preset Default parameters.
 * @return {Object}
 * @ignore
 */
function updateParams(update, preset) {
    if (update) {
      for (var param in update) {
        preset[param] = update[param] || preset[param];
      }
    }
    return preset;
}

/**
 * Returns a states overlay image.
 *
 * @param {Object} params An object that provides states overlay parameters.
 * @param {String} [params.color='000000'] Outline color.
 * @param {Number} [params.opacity=0.6] Outline opacity.
 * @param {Number} [params.width=1] Outline width.
 * @return {ee.Image}
 */
function getStatesOverlay(params) {
  // Define default parameters and update from input.
  var _params = {
    'color': '000000',
    'opacity': 0.6,
    'width': 1
  };
  _params = updateParams(params, _params);

  var states = ee.FeatureCollection('FAO/GAUL/2015/level1');
  return ee.Image().byte()
    .paint({featureCollection: states, color: 1, width: _params.width})
    .visualize({palette: _params.color, opacity: _params.opacity});
}
exports.getStatesOverlay = getStatesOverlay;

/**
 * Properly scales an MCMIP image.
 *
 * @param {ee.Image} img An unaltered MCMIP image.
 * @return {ee.Image}
 * @ignore
 */
var applyScaleAndOffset = function(img) {
  var names = img.select('CMI_C..').bandNames();

  // Scale the radiance bands using the image's metadata.
  var scales = names.map(function(name) {
    return img.getNumber(ee.String(name).cat('_scale'));
  });
  var offsets = names.map(function(name) {
    return img.getNumber(ee.String(name).cat('_offset'));
  });
  var scaled = img.select('CMI_C..')
                   .multiply(ee.Image.constant(scales))
                   .add(ee.Image.constant(offsets));

  return img.addBands({srcImg: scaled, overwrite: true});
};

/**
 * Computes and adds a green radiance band to a MCMIP image.
 *
 * The image must already have been properly scaled via applyScaleAndOffset.
 *
 * For more information on computing the green band, see:
 *   https://doi.org/10.1029/2018EA000379
 *
 * @param {ee.Image} img An image to add a green radiance band to. It
 *     must be the result of the applyScaleAndOffset function.
 * @return {ee.Image}
 * @ignore
 */
var addGreenBand = function(img) {
  function toBandExpression(bandName) { return 'b(\'' + bandName + '\')'; }

  var blue = toBandExpression('CMI_C01');
  var red = toBandExpression('CMI_C02');
  var veggie = toBandExpression('CMI_C03');

  // green = 0.45 * red + 0.10 * nir + 0.45 * blue
  var greenExpr = 'GREEN = 0.45 * ' + red + ' + 0.10 * ' + veggie +
      ' + 0.45 * ' + blue;

  var green = img.expression(greenExpr).select('GREEN');
  return img.addBands(green);
};

/**
 * Creates a GOES MCMIP visualization image collection.
 *
 * @param {ee.ImageCollection} col An image collection to be visualized.
 *     An image collection resulting from getMcmipCol.
 * @param {Object} params Optional visualization parameters.
 * @return {ee.ImageCollection}
 */
function visualizeMcmip(col, params) {
  // Define default parameters and update from input.
  var _params = {
    'resample': null,  // 'bilinear' or 'bicubic',
    'visParams': trueColorLand,
    'reproject': null,  // {crs: VID_PARAMS.crs, scale: 1500},
  };
  _params = updateParams(params, _params);
  
  // Resample maybe.
  if (_params.resample == 'bilinear' | _params.resample == 'bicubic' ) {
    col = col.map(function(img) {
      return img.resample(_params.resample);
    });
  }
  
  // Reproject maybe.
  if (_params.reproject) {
    col = col.map(function(img) {
      return img.reproject(_params.reproject);
    });
  }
  
  // Return RGB.
  return col.map(function(img) {
    return img.visualize(_params.visParams)
      .set('system:time_start', img.get('system:time_start'));
  });
}
exports.visualizeMcmip = visualizeMcmip;

/**
 * Creates a GOES Nighttime Microphysics RGB visualization image collection.
 *
 * @param {ee.ImageCollection} col An image collection to be visualized.
 *     An image collection resulting from getMcmipCol.
 * @param {Object} params Optional visualization parameters.
 * @return {ee.ImageCollection}
 */
function visualizeNtMicro(col, params) {
  // Calculates Nighttime Microphysics RGB.
  //https://www.star.nesdis.noaa.gov/GOES/documents/QuickGuide_GOESR_NtMicroRGB_final.pdf
  //http://oiswww.eumetsat.int/~idds/html/doc/best_practices.pdf
  var calcNtMicro = function(img) {
    var r = img.expression(
        '(((b1 - b2) - -6.7) / (2.6 - -6.7)) * 255',
        {b1: img.select('CMI_C15'), b2: img.select('CMI_C13')});
    var g = img.expression(
        '(((b1 - b2) - -3.1) / (5.2 - -3.1)) * 255',
        {b1: img.select('CMI_C13'), b2: img.select('CMI_C07')});
    var b = img.expression(
        '(((b1) - 243.55) / (292.65 - 243.55)) * 255',
        {b1: img.select('CMI_C13')});
    return ee.Image.cat(r, g, b).visualize({min: 0, max: 255})
      .set('system:time_start', img.get('system:time_start'));
  };

  // Define default parameters and update from input.
  var _params = {
    'resample': null,  // 'bilinear' or 'bicubic',
    'reproject': null,  // {crs: VID_PARAMS.crs, scale: 1500},
    'overlay': null
  };
  _params = updateParams(params, _params);
  
  // Resample maybe.
  if (_params.resample == 'bilinear' | _params.resample == 'bicubic' ) {
    col = col.map(function(img) {
      return img.resample(_params.resample);
    });
  }
  
  // Reproject maybe.
  if (_params.reproject) {
    col = col.map(function(img) {
      return img.reproject(_params.reproject);
    });
  }

  return col.map(calcNtMicro);
}
exports.visualizeNtMicro = visualizeNtMicro;

/**
 * Gets a GOES MCMIP image collection.
 *
 * @param {String} colId A GOES MCMIP image collection ID.
 * @param {String} startTime The desired collection start date/time as UTC.
 * @param {String} endTime The desired collection end date/time as UTC.
 * @param {Object} params Optional parameters for filtering by hours and
 *     sampling by series step.
 * @return {ee.ImageCollection}
 */
function getMcmipCol(colId, startTime, endTime, params) {
  // Define default parameters and update from input.
  var _params = {
    'filterHours': null,  // [9, 22]
    'step': null  // 3
  };
  _params = updateParams(params, _params);

  // Build the base collection.
  var col = ee.ImageCollection(colId).filterDate(ee.Date(startTime), endTime);
  if (_params.filterHours) {
    col = col.filter(
      ee.Filter.calendarRange(
        _params.filterHours[0], _params.filterHours[1], 'hour'));
  }
  if (_params.step) {
    col = ee.ImageCollection.fromImages(
      col.toList(col.size()).slice(0, -1, params.step));
  }

  return col
    .map(applyScaleAndOffset)
    .map(addGreenBand)
    .map(function(img) {
      return img.set({col_id: colId});
    });
}
exports.getMcmipCol = getMcmipCol;

/**
 * Adds an overlay image to all images in a collection.
 *
 * @param {ee.ImageCollection} col An image collection to add an overlay to.
 * @param {ee.Image} overlay An image to add as an overlay to all images in the
 *     given collection.
 * @return {ee.ImageCollection}
 */
function addOverlay(col, overlay) {
  var proj = col.first().projection();
  return col.map(function(img) {
    return img.blend(overlay)
      .set('system:time_start', img.get('system:time_start'))
      .reproject('EPSG:4326', null, 2000);
  });
}
exports.addOverlay = addOverlay;

/**
 * Creates progressively shifted image collection to track events.
 *
 * @param {ee.ImageCollection} col An image collection to add an overlay to.
 * @param {ee.Geometry.point} startPoint Point for start of shift. Used
 *     to determine delta and direction to shift the animation frame.
 * @param {ee.Geometry.point} endPoint Point for end of shift. Used
 *     to determine delta and direction to shift the animation frame.
 * @return {ee.ImageCollection}
 */
function shiftFrames(col, startPoint, endPoint) {
  // Figure out the transform distance interval x, y
  var startLoc = ee.List(startPoint.coordinates());
  var endLoc = ee.List(endPoint.coordinates());
  var xDelta = ee.Number(endLoc.get(0)).subtract(ee.Number(startLoc.get(0))).multiply(-1);
  var yDelta = ee.Number(endLoc.get(1)).subtract(ee.Number(startLoc.get(1))).multiply(-1);
  var xMove = ee.Number(xDelta.divide(col.size()).multiply(111000));  // Degrees to meters
  var yMove = ee.Number(yDelta.divide(col.size()).multiply(111000));  // Degrees to meters
  
  // Shift each image in the collection.
  var timestamps = col.sort('system:time_start')
                        .aggregate_array('system:time_start');
  var seq = ee.List.sequence(0, ee.Number(timestamps.size()).subtract(1));
  var colShift = ee.ImageCollection.fromImages(seq.map(function(i) {
    var img = ee.Image(col.filter(ee.Filter.eq('system:time_start', timestamps.get(i))).first());
    return img.translate({
      x: xMove.multiply(ee.Number(i)),
      y: yMove.multiply(ee.Number(i)),
      units: 'meters',
      proj: 'EPSG:5070'
    }).set('system:time_start', img.get('system:time_start'));
  }));
  
  return colShift;
}
exports.shiftFrames = shiftFrames;

/**
 * Shows a GOES animated time series GIF in the console.
 *
 * @param {ee.ImageCollection} col A GOES RGB visualization image collection.
 * @param {ee.Geometry} region A geometry that defines the region to render.
 * @param {Object} params Optional parameter object specifying arguments for
 *     https://developers.google.com/earth-engine/apidocs/ee-imagecollection-getvideothumburl
 */
function showGif(col, region, params) {
  // Define default parameters and update from input.
  var _params = {
    'dimensions': 512,
    'region': region,
    'framesPerSecond': 10,
    'crs': 'EPSG:3857',
    'printUrl': false
  };
  _params = updateParams(params, _params);
  
  print('Animated GIF (to save, right-click and "Save image as")');
  print(ui.Thumbnail(col, _params));
  if (_params.printUrl) {
    print('Animated GIF URL');
    col.getVideoThumbURL(_params);
  }
}
exports.showGif = showGif;

/**
 * Exports a GOES animated time series video to Google Drive as MP4.
 *
 * @param {ee.ImageCollection} col A GOES RGB visualization image collection.
 * @param {ee.Geometry} region A geometry that defines the region to render.
 * @param {Object} params Optional parameter object specifying arguments for
 *     https://developers.google.com/earth-engine/apidocs/export-video-todrive
 */
function exportMp4(col, region, params) {
  // Define default parameters and update from input.
  var _params = {
    'collection': col,
    'description': 'GOES Video',
    'folder': '',
    'fileNamePrefix': 'goes_video',
    'dimensions': 512,
    'region': region,
    'framesPerSecond': 10,
    'crs': 'EPSG:3857'
  };
  _params = updateParams(params, _params);
  
  Export.video.toDrive(_params);
}
exports.exportMp4 = exportMp4;
